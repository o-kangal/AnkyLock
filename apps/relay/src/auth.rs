use std::future::Future;
use std::pin::Pin;
use std::time::{Duration, Instant};

use jsonwebtoken::jwk::JwkSet;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use tokio::sync::RwLock;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Opaque per-user routing key (the Google `sub`). Never logged.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AccountId(pub String);

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("missing or malformed token")]
    Malformed,
    #[error("invalid token: {0}")]
    Invalid(String),
    #[error("signing keys unavailable: {0}")]
    KeysUnavailable(String),
}

/// Verifies a bearer token and returns the account it belongs to. The relay never reads payloads.
pub trait Authenticator: Send + Sync + 'static {
    fn authenticate<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<AccountId, AuthError>>;
}

/// Where JWT signing keys come from; Google's JWKS endpoint in production, a fixture in tests.
pub trait KeySource: Send + Sync + 'static {
    fn fetch(&self) -> BoxFuture<'_, Result<JwkSet, AuthError>>;
}

pub const GOOGLE_JWKS_URL: &str = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS: [&str; 2] = ["accounts.google.com", "https://accounts.google.com"];

pub struct GoogleJwksSource {
    client: reqwest::Client,
}

impl GoogleJwksSource {
    pub fn new() -> Self {
        Self { client: reqwest::Client::new() }
    }
}

impl Default for GoogleJwksSource {
    fn default() -> Self {
        Self::new()
    }
}

impl KeySource for GoogleJwksSource {
    fn fetch(&self) -> BoxFuture<'_, Result<JwkSet, AuthError>> {
        Box::pin(async move {
            let unavailable = |e: reqwest::Error| AuthError::KeysUnavailable(e.to_string());
            let body = self
                .client
                .get(GOOGLE_JWKS_URL)
                .send()
                .await
                .map_err(unavailable)?
                .error_for_status()
                .map_err(unavailable)?
                .text()
                .await
                .map_err(unavailable)?;
            serde_json::from_str(&body).map_err(|e| AuthError::KeysUnavailable(e.to_string()))
        })
    }
}

#[derive(Debug, Deserialize)]
struct Claims {
    sub: String,
}

struct CachedKeys {
    keys: JwkSet,
    fetched_at: Instant,
}

/// Validates Google ID tokens: RS256 signature against Google's published keys, issuer,
/// audience (our OAuth client id) and expiry. The account id is the token's `sub`.
/// The OAuth identity only routes frames; it never touches the encryption key (BR-SEC-03).
pub struct GoogleAuthenticator<S: KeySource> {
    client_id: String,
    source: S,
    cache: RwLock<Option<CachedKeys>>,
    /// Keys are refetched after this age even when every `kid` still matches.
    ttl: Duration,
    /// Minimum gap between refetches triggered by an unknown `kid`, so forged tokens can't
    /// make the relay hammer Google.
    min_refetch: Duration,
}

impl<S: KeySource> GoogleAuthenticator<S> {
    pub fn new(client_id: impl Into<String>, source: S) -> Self {
        Self::with_intervals(client_id, source, Duration::from_secs(3600), Duration::from_secs(60))
    }

    pub fn with_intervals(client_id: impl Into<String>, source: S, ttl: Duration, min_refetch: Duration) -> Self {
        Self { client_id: client_id.into(), source, cache: RwLock::new(None), ttl, min_refetch }
    }

    async fn refresh(&self) -> Result<(), AuthError> {
        let keys = self.source.fetch().await?;
        *self.cache.write().await = Some(CachedKeys { keys, fetched_at: Instant::now() });
        Ok(())
    }

    async fn decoding_key(&self, kid: &str) -> Result<DecodingKey, AuthError> {
        let lookup = |cache: &Option<CachedKeys>| -> Option<Result<DecodingKey, AuthError>> {
            let jwk = cache.as_ref()?.keys.find(kid)?;
            Some(DecodingKey::from_jwk(jwk).map_err(|e| AuthError::KeysUnavailable(e.to_string())))
        };

        let (stale, can_refetch) = {
            let cache = self.cache.read().await;
            match cache.as_ref() {
                Some(c) => (c.fetched_at.elapsed() >= self.ttl, c.fetched_at.elapsed() >= self.min_refetch),
                None => (true, true),
            }
        };
        if stale {
            self.refresh().await?;
        }
        if let Some(key) = lookup(&*self.cache.read().await) {
            return key;
        }
        // Google rotates keys; an unknown kid may simply be newer than our cache.
        if !stale && can_refetch {
            self.refresh().await?;
            if let Some(key) = lookup(&*self.cache.read().await) {
                return key;
            }
        }
        Err(AuthError::Invalid("unknown signing key".into()))
    }
}

impl<S: KeySource> Authenticator for GoogleAuthenticator<S> {
    fn authenticate<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<AccountId, AuthError>> {
        Box::pin(async move {
            let header = decode_header(token).map_err(|_| AuthError::Malformed)?;
            if header.alg != Algorithm::RS256 {
                return Err(AuthError::Invalid("unexpected algorithm".into()));
            }
            let kid = header.kid.ok_or(AuthError::Malformed)?;
            let key = self.decoding_key(&kid).await?;

            let mut validation = Validation::new(Algorithm::RS256);
            validation.set_audience(&[&self.client_id]);
            validation.set_issuer(&GOOGLE_ISSUERS);
            validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
            let data = decode::<Claims>(token, &key, &validation).map_err(|e| AuthError::Invalid(e.to_string()))?;
            if data.claims.sub.is_empty() {
                return Err(AuthError::Invalid("empty subject".into()));
            }
            Ok(AccountId(data.claims.sub))
        })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use jsonwebtoken::{encode, EncodingKey, Header};
    use serde::Serialize;

    use super::*;

    const CLIENT_ID: &str = "ankylock-test.apps.googleusercontent.com";
    const JWKS: &str = include_str!("../tests/fixtures/jwks.json");
    const SIGNING_KEY: &str = include_str!("../tests/fixtures/test_rsa_private.pem");
    const OTHER_KEY: &str = include_str!("../tests/fixtures/other_rsa_private.pem");

    #[derive(Clone)]
    struct FixtureSource {
        fetches: Arc<AtomicUsize>,
    }

    impl KeySource for FixtureSource {
        fn fetch(&self) -> BoxFuture<'_, Result<JwkSet, AuthError>> {
            self.fetches.fetch_add(1, Ordering::SeqCst);
            Box::pin(async { Ok(serde_json::from_str(JWKS).unwrap()) })
        }
    }

    #[derive(Serialize)]
    struct TestClaims<'a> {
        iss: &'a str,
        aud: &'a str,
        sub: &'a str,
        exp: u64,
    }

    fn now() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()
    }

    fn token(pem: &str, kid: &str, claims: &TestClaims<'_>) -> String {
        let mut header = Header::new(Algorithm::RS256);
        header.kid = Some(kid.into());
        encode(&header, claims, &EncodingKey::from_rsa_pem(pem.as_bytes()).unwrap()).unwrap()
    }

    fn valid_claims() -> TestClaims<'static> {
        TestClaims { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "1234567890", exp: now() + 600 }
    }

    fn authenticator(min_refetch: Duration) -> (GoogleAuthenticator<FixtureSource>, Arc<AtomicUsize>) {
        let fetches = Arc::new(AtomicUsize::new(0));
        let source = FixtureSource { fetches: fetches.clone() };
        (GoogleAuthenticator::with_intervals(CLIENT_ID, source, Duration::from_secs(3600), min_refetch), fetches)
    }

    fn invalid(result: Result<AccountId, AuthError>) -> bool {
        matches!(result, Err(AuthError::Invalid(_) | AuthError::Malformed))
    }

    #[tokio::test]
    async fn accepts_a_valid_google_id_token_and_caches_keys() {
        let (auth, fetches) = authenticator(Duration::from_secs(60));
        let t = token(SIGNING_KEY, "test-key-1", &valid_claims());
        assert_eq!(auth.authenticate(&t).await.unwrap(), AccountId("1234567890".into()));
        assert_eq!(auth.authenticate(&t).await.unwrap(), AccountId("1234567890".into()));
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn accepts_the_bare_issuer_form() {
        let (auth, _) = authenticator(Duration::from_secs(60));
        let claims = TestClaims { iss: "accounts.google.com", ..valid_claims() };
        assert!(auth.authenticate(&token(SIGNING_KEY, "test-key-1", &claims)).await.is_ok());
    }

    #[tokio::test]
    async fn rejects_wrong_audience_issuer_expiry_or_subject() {
        let (auth, _) = authenticator(Duration::from_secs(60));
        let cases = [
            TestClaims { aud: "someone-else", ..valid_claims() },
            TestClaims { iss: "https://evil.example", ..valid_claims() },
            TestClaims { exp: now() - 3600, ..valid_claims() },
            TestClaims { sub: "", ..valid_claims() },
        ];
        for claims in &cases {
            assert!(invalid(auth.authenticate(&token(SIGNING_KEY, "test-key-1", claims)).await));
        }
    }

    #[tokio::test]
    async fn rejects_a_signature_from_another_key() {
        let (auth, _) = authenticator(Duration::from_secs(60));
        assert!(invalid(auth.authenticate(&token(OTHER_KEY, "test-key-1", &valid_claims())).await));
    }

    #[tokio::test]
    async fn rejects_garbage_and_non_rs256_tokens() {
        let (auth, _) = authenticator(Duration::from_secs(60));
        assert!(invalid(auth.authenticate("not-a-jwt").await));
        let hs256 = encode(&Header::new(Algorithm::HS256), &valid_claims(), &EncodingKey::from_secret(b"s")).unwrap();
        assert!(invalid(auth.authenticate(&hs256).await));
    }

    #[tokio::test]
    async fn refetches_keys_for_an_unknown_kid_at_most_once_per_interval() {
        let (auth, fetches) = authenticator(Duration::ZERO);
        auth.authenticate(&token(SIGNING_KEY, "test-key-1", &valid_claims())).await.unwrap();
        assert!(invalid(auth.authenticate(&token(SIGNING_KEY, "rotated", &valid_claims())).await));
        assert_eq!(fetches.load(Ordering::SeqCst), 2);

        let (throttled, fetches) = authenticator(Duration::from_secs(60));
        throttled.authenticate(&token(SIGNING_KEY, "test-key-1", &valid_claims())).await.unwrap();
        assert!(invalid(throttled.authenticate(&token(SIGNING_KEY, "rotated", &valid_claims())).await));
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
    }
}

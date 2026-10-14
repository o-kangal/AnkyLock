//! Google sign-in for the desktop app: OAuth 2.0 authorization code flow with PKCE (RFC 7636)
//! in the system browser and a one-shot loopback redirect (RFC 8252). The refresh token lives
//! only in the OS keychain; the frontend receives short-lived ID and access tokens. These tokens
//! authenticate to the relay and Google Drive and never touch key material (BR-SEC-03).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::error::{AppError, AppResult};

const AUTH_ENDPOINT: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT: &str = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT: &str = "https://oauth2.googleapis.com/revoke";
/// Identity for the relay plus the app's hidden Drive folder; nothing else in the user's Drive.
const SCOPES: &str = "openid email https://www.googleapis.com/auth/drive.appdata";
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// Matches `identifier` in tauri.conf.json, so the keychain entry belongs to this app.
const KEYCHAIN_SERVICE: &str = "com.ankylock.desktop";
const KEYCHAIN_ACCOUNT: &str = "google-refresh-token";

/// Short-lived tokens handed to the frontend. The refresh token never leaves the host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id_token: String,
    pub access_token: String,
    /// Epoch milliseconds when both tokens expire.
    pub expires_at: i64,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: i64,
    id_token: Option<String>,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct TokenError {
    error: String,
}

/// Where the refresh token is kept: the OS keychain in the app, memory in tests.
pub trait SecretStore: Send + Sync {
    fn get(&self) -> AppResult<Option<String>>;
    fn set(&self, value: &str) -> AppResult<()>;
    fn delete(&self) -> AppResult<()>;
}

/// macOS Keychain, Windows Credential Manager or the Secret Service (GNOME Keyring, KWallet).
pub struct KeychainStore;

impl KeychainStore {
    fn entry() -> AppResult<keyring::Entry> {
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).map_err(|e| AppError::Auth(format!("Keychain unavailable: {e}")))
    }
}

impl SecretStore for KeychainStore {
    fn get(&self) -> AppResult<Option<String>> {
        match Self::entry()?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Auth(format!("Keychain read failed: {e}"))),
        }
    }

    fn set(&self, value: &str) -> AppResult<()> {
        Self::entry()?.set_password(value).map_err(|e| AppError::Auth(format!("Keychain write failed: {e}")))
    }

    fn delete(&self) -> AppResult<()> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Auth(format!("Keychain delete failed: {e}"))),
        }
    }
}

/// The OAuth client compiled in from `.env.local` (see build.rs).
pub struct OAuthClient {
    client_id: String,
    client_secret: String,
    token_endpoint: String,
    http: reqwest::Client,
}

impl OAuthClient {
    pub fn new(client_id: &str, client_secret: &str, token_endpoint: &str) -> Self {
        Self {
            client_id: client_id.into(),
            client_secret: client_secret.into(),
            token_endpoint: token_endpoint.into(),
            http: reqwest::Client::new(),
        }
    }

    pub fn from_build_env() -> Option<Self> {
        let id = option_env!("ANKYLOCK_GOOGLE_CLIENT_ID").filter(|v| !v.is_empty())?;
        let secret = option_env!("ANKYLOCK_GOOGLE_CLIENT_SECRET").unwrap_or_default();
        Some(Self::new(id, secret, TOKEN_ENDPOINT))
    }

    async fn token_request(&self, form: &[(&str, &str)]) -> AppResult<TokenResponse> {
        let mut params = vec![("client_id", self.client_id.as_str()), ("client_secret", self.client_secret.as_str())];
        params.extend_from_slice(form);
        let response = self
            .http
            .post(&self.token_endpoint)
            .form(&params)
            .send()
            .await
            .map_err(|e| AppError::Network(e.to_string()))?;
        let status = response.status();
        let body = response.text().await.map_err(|e| AppError::Network(e.to_string()))?;
        if status.is_success() {
            return serde_json::from_str(&body).map_err(|e| AppError::Auth(format!("Unexpected token response: {e}")));
        }
        match serde_json::from_str::<TokenError>(&body) {
            Ok(TokenError { error }) if error == "invalid_grant" => Err(AppError::AuthExpired),
            Ok(TokenError { error }) => Err(AppError::Auth(format!("Google rejected the request: {error}"))),
            Err(_) => Err(AppError::Auth(format!("Google token endpoint returned HTTP {status}"))),
        }
    }

    async fn exchange_code(&self, code: &str, verifier: &str, redirect_uri: &str) -> AppResult<TokenResponse> {
        self.token_request(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("code_verifier", verifier),
            ("redirect_uri", redirect_uri),
        ])
        .await
    }

    async fn refresh(&self, refresh_token: &str) -> AppResult<TokenResponse> {
        self.token_request(&[("grant_type", "refresh_token"), ("refresh_token", refresh_token)]).await
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

fn session_from(tokens: &TokenResponse) -> AppResult<Session> {
    let id_token = tokens.id_token.clone().ok_or_else(|| AppError::Auth("Google returned no ID token.".into()))?;
    Ok(Session { id_token, access_token: tokens.access_token.clone(), expires_at: now_ms() + tokens.expires_in * 1000 })
}

fn random_url_safe(bytes: usize) -> AppResult<String> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).map_err(|e| AppError::Auth(format!("No secure randomness: {e}")))?;
    Ok(URL_SAFE_NO_PAD.encode(buffer))
}

/// RFC 7636 S256 challenge for a verifier.
fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorization_url(client_id: &str, redirect_uri: &str, challenge: &str, state: &str) -> String {
    let params = [
        ("client_id", client_id),
        ("redirect_uri", redirect_uri),
        ("response_type", "code"),
        ("scope", SCOPES),
        ("code_challenge", challenge),
        ("code_challenge_method", "S256"),
        ("state", state),
        // A refresh token is only issued with offline access and an explicit consent prompt.
        ("access_type", "offline"),
        ("prompt", "consent"),
    ];
    Url::parse_with_params(AUTH_ENDPOINT, &params).map_or_else(|_| AUTH_ENDPOINT.into(), |url| url.to_string())
}

/// Extracts the authorization code from the redirect's request line, checking `state` (CSRF).
fn parse_callback(request_line: &str, expected_state: &str) -> AppResult<String> {
    let target = request_line.split_whitespace().nth(1).ok_or_else(|| AppError::Auth("Malformed redirect.".into()))?;
    let url = Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| AppError::Auth("Malformed redirect.".into()))?;
    let query = |name: &str| url.query_pairs().find(|(k, _)| k == name).map(|(_, v)| v.into_owned());
    if query("state").as_deref() != Some(expected_state) {
        return Err(AppError::Auth("Sign-in response did not match this request.".into()));
    }
    if let Some(error) = query("error") {
        return Err(AppError::Auth(if error == "access_denied" {
            "Google sign-in was cancelled.".into()
        } else {
            format!("Google sign-in failed: {error}")
        }));
    }
    query("code").ok_or_else(|| AppError::Auth("Google returned no authorization code.".into()))
}

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>AnkyLock</title>\
<body style=\"font:15px system-ui;padding:40px\">You can close this tab and return to AnkyLock.";

/// Serves exactly one request on the loopback listener and returns the authorization code.
async fn wait_for_code(listener: TcpListener, state: &str) -> AppResult<String> {
    let (mut socket, _) = listener.accept().await.map_err(|e| AppError::Network(e.to_string()))?;
    let mut buffer = vec![0u8; 8192];
    let mut read = 0;
    while read < buffer.len() {
        let n = socket.read(&mut buffer[read..]).await.map_err(|e| AppError::Network(e.to_string()))?;
        read += n;
        if n == 0 || buffer[..read].windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    let request = String::from_utf8_lossy(&buffer[..read]);
    let result = parse_callback(request.lines().next().unwrap_or_default(), state);
    let body = if result.is_ok() { DONE_PAGE } else { "Sign-in failed. You can close this tab." };
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    // The page is a courtesy; a failure to deliver it does not affect the sign-in.
    let _ = socket.write_all(response.as_bytes()).await;
    result
}

/// Managed state: the compiled-in OAuth client (None when not configured) and the token store.
pub struct GoogleAuth {
    pub client: Option<OAuthClient>,
    pub store: Box<dyn SecretStore>,
}

impl GoogleAuth {
    fn client(&self) -> AppResult<&OAuthClient> {
        self.client
            .as_ref()
            .ok_or_else(|| AppError::Auth("Google sign-in is not configured in this build.".into()))
    }

    async fn sign_in_with(&self, open_browser: impl FnOnce(&str) -> AppResult<()>) -> AppResult<Session> {
        let client = self.client()?;
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| AppError::Network(e.to_string()))?;
        let port = listener.local_addr().map_err(|e| AppError::Network(e.to_string()))?.port();
        let redirect_uri = format!("http://127.0.0.1:{port}");
        let verifier = random_url_safe(32)?;
        let state = random_url_safe(16)?;
        open_browser(&authorization_url(&client.client_id, &redirect_uri, &pkce_challenge(&verifier), &state))?;
        let code = tokio::time::timeout(SIGN_IN_TIMEOUT, wait_for_code(listener, &state))
            .await
            .map_err(|_| AppError::Auth("Google sign-in timed out.".into()))??;
        let tokens = client.exchange_code(&code, &verifier, &redirect_uri).await?;
        if let Some(refresh) = &tokens.refresh_token {
            self.store.set(refresh)?;
        }
        session_from(&tokens)
    }

    /// Fresh tokens from the stored refresh token. A revoked or expired one is deleted.
    async fn refresh(&self) -> AppResult<Session> {
        let refresh_token = self.store.get()?.ok_or(AppError::AuthExpired)?;
        match self.client()?.refresh(&refresh_token).await {
            Ok(tokens) => session_from(&tokens),
            Err(AppError::AuthExpired) => {
                self.store.delete()?;
                Err(AppError::AuthExpired)
            }
            Err(e) => Err(e),
        }
    }
}

#[tauri::command]
pub async fn oauth_sign_in(app: AppHandle, auth: State<'_, GoogleAuth>) -> AppResult<Session> {
    auth.sign_in_with(|url| {
        app.opener()
            .open_url(url, None::<&str>)
            .map_err(|e| AppError::Auth(format!("Could not open the browser: {e}")))
    })
    .await
}

/// Restores a session at startup without user interaction; None when not signed in.
#[tauri::command]
pub async fn oauth_restore(auth: State<'_, GoogleAuth>) -> AppResult<Option<Session>> {
    if auth.client.is_none() || auth.store.get()?.is_none() {
        return Ok(None);
    }
    match auth.refresh().await {
        Ok(session) => Ok(Some(session)),
        Err(AppError::AuthExpired) => Ok(None),
        Err(e) => Err(e),
    }
}

#[tauri::command]
pub async fn oauth_refresh(auth: State<'_, GoogleAuth>) -> AppResult<Session> {
    auth.refresh().await
}

/// Revokes the grant at Google (best effort) and forgets the refresh token.
#[tauri::command]
pub async fn oauth_sign_out(auth: State<'_, GoogleAuth>) -> AppResult<()> {
    if let (Some(client), Some(token)) = (auth.client.as_ref(), auth.store.get()?) {
        let _ = client.http.post(REVOKE_ENDPOINT).form(&[("token", token.as_str())]).send().await;
    }
    auth.store.delete()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;

    use super::*;

    #[derive(Default)]
    struct MemoryStore(Mutex<Option<String>>);

    impl SecretStore for MemoryStore {
        fn get(&self) -> AppResult<Option<String>> {
            Ok(self.0.lock().unwrap().clone())
        }
        fn set(&self, value: &str) -> AppResult<()> {
            *self.0.lock().unwrap() = Some(value.into());
            Ok(())
        }
        fn delete(&self) -> AppResult<()> {
            *self.0.lock().unwrap() = None;
            Ok(())
        }
    }

    /// Fake token endpoint answering every request with `status` and `body`; returns its URL
    /// and the request bodies it received.
    async fn fake_token_endpoint(status: u16, body: &'static str) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let seen = std::sync::Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0u8; 8192];
                let n = socket.read(&mut buf).await.unwrap();
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                log.lock().unwrap().push(request.split("\r\n\r\n").nth(1).unwrap_or_default().to_string());
                let response = format!(
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(response.as_bytes()).await.unwrap();
            }
        });
        (url, seen)
    }

    const TOKENS: &str = r#"{"access_token":"at","expires_in":3600,"id_token":"idt","refresh_token":"rt"}"#;

    fn auth(endpoint: &str, store: MemoryStore) -> GoogleAuth {
        GoogleAuth { client: Some(OAuthClient::new("client-id", "secret", endpoint)), store: Box::new(store) }
    }

    #[test]
    fn keychain_service_matches_the_bundle_identifier() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], KEYCHAIN_SERVICE);
    }

    #[test]
    fn pkce_matches_the_rfc_7636_example() {
        assert_eq!(pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
        assert_eq!(random_url_safe(32).unwrap().len(), 43);
        assert_ne!(random_url_safe(32).unwrap(), random_url_safe(32).unwrap());
    }

    #[test]
    fn authorization_url_requests_pkce_offline_access_and_minimal_scopes() {
        let url = Url::parse(&authorization_url("cid", "http://127.0.0.1:5000", "chal", "st")).unwrap();
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["code_challenge_method"], "S256");
        assert_eq!(q["code_challenge"], "chal");
        assert_eq!(q["redirect_uri"], "http://127.0.0.1:5000");
        assert_eq!(q["access_type"], "offline");
        assert_eq!(q["scope"], "openid email https://www.googleapis.com/auth/drive.appdata");
    }

    #[test]
    fn callback_requires_matching_state() {
        assert_eq!(parse_callback("GET /?state=s1&code=abc HTTP/1.1", "s1").unwrap(), "abc");
        assert_eq!(parse_callback("GET /?state=evil&code=abc HTTP/1.1", "s1").unwrap_err().code(), "ERR_AUTH");
        let cancelled = parse_callback("GET /?state=s1&error=access_denied HTTP/1.1", "s1").unwrap_err();
        assert_eq!(cancelled.to_string(), "Google sign-in was cancelled.");
    }

    #[tokio::test]
    async fn sign_in_exchanges_the_loopback_code_and_keeps_the_refresh_token_in_the_store() {
        let (endpoint, seen) = fake_token_endpoint(200, TOKENS).await;
        let auth = auth(&endpoint, MemoryStore::default());
        let session = auth
            .sign_in_with(|url| {
                // Play the browser: follow the redirect Google would send.
                let url = Url::parse(url).unwrap();
                let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
                let redirect = format!("{}/?state={}&code=the-code", q["redirect_uri"], q["state"]);
                tokio::spawn(async move {
                    let target = Url::parse(&redirect).unwrap();
                    let mut stream = TcpStream::connect((target.host_str().unwrap(), target.port().unwrap())).await.unwrap();
                    let request = format!("GET /?{} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n", target.query().unwrap());
                    stream.write_all(request.as_bytes()).await.unwrap();
                    let mut page = String::new();
                    stream.read_to_string(&mut page).await.unwrap();
                    assert!(page.contains("You can close this tab"));
                });
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!((session.id_token.as_str(), session.access_token.as_str()), ("idt", "at"));
        assert!(session.expires_at > now_ms());
        assert_eq!(auth.store.get().unwrap().as_deref(), Some("rt"));
        let body = seen.lock().unwrap()[0].clone();
        assert!(body.contains("grant_type=authorization_code") && body.contains("code=the-code") && body.contains("code_verifier="));
    }

    #[tokio::test]
    async fn refresh_uses_the_stored_token_and_forgets_it_when_revoked() {
        let (ok_endpoint, seen) = fake_token_endpoint(200, TOKENS).await;
        let store = MemoryStore::default();
        store.set("stored-rt").unwrap();
        let auth = auth(&ok_endpoint, store);
        assert_eq!(auth.refresh().await.unwrap().id_token, "idt");
        assert!(seen.lock().unwrap()[0].contains("refresh_token=stored-rt"));

        let (revoked, _) = fake_token_endpoint(400, r#"{"error":"invalid_grant"}"#).await;
        let store = MemoryStore::default();
        store.set("old").unwrap();
        let auth = super::tests::auth(&revoked, store);
        assert_eq!(auth.refresh().await.unwrap_err().code(), "ERR_AUTH_EXPIRED");
        assert_eq!(auth.store.get().unwrap(), None);
    }

    #[tokio::test]
    async fn reports_missing_configuration_and_missing_session() {
        let unconfigured = GoogleAuth { client: None, store: Box::new(MemoryStore::default()) };
        assert_eq!(unconfigured.sign_in_with(|_| Ok(())).await.unwrap_err().code(), "ERR_AUTH");
        let (endpoint, _) = fake_token_endpoint(200, TOKENS).await;
        assert_eq!(auth(&endpoint, MemoryStore::default()).refresh().await.unwrap_err().code(), "ERR_AUTH_EXPIRED");
    }
}

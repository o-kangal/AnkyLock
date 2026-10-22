use std::net::SocketAddr;

/// SPEC limits plaintext notes to 10 MB; base64, the JSON envelope and the GCM overhead add
/// roughly a third on top.
pub const DEFAULT_MAX_FRAME_BYTES: usize = 14 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: SocketAddr,
    /// OAuth client ids that Google ID tokens may be issued for (`aud`): one per app
    /// (desktop, web), given comma-separated in `GOOGLE_CLIENT_ID`.
    pub google_client_ids: Vec<String>,
    pub max_frame_bytes: usize,
    /// Frames buffered per channel before a slow connection is dropped. With the frame limit,
    /// this bounds a channel's memory (32 × 14 MB at most).
    pub channel_capacity: usize,
    /// Open connections per Google account, across its vaults and devices.
    pub max_connections_per_account: usize,
    /// A connection that sends nothing (clients ping every 25 s) for this long is closed.
    pub idle_timeout_secs: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("environment variable {0} is required")]
    Missing(&'static str),
    #[error("environment variable {0} is invalid: {1}")]
    Invalid(&'static str, String),
}

impl Config {
    /// Reads `RELAY_BIND` (default `0.0.0.0:8787`), `GOOGLE_CLIENT_ID` (required),
    /// `RELAY_MAX_FRAME_BYTES`, `RELAY_CHANNEL_CAPACITY`, `RELAY_MAX_CONNECTIONS_PER_ACCOUNT` and
    /// `RELAY_IDLE_TIMEOUT_SECS`.
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        fn parse<T: std::str::FromStr>(name: &'static str, raw: Option<String>, default: T) -> Result<T, ConfigError>
        where
            T::Err: std::fmt::Display,
        {
            raw.map_or(Ok(default), |v| v.parse().map_err(|e: T::Err| ConfigError::Invalid(name, e.to_string())))
        }

        Ok(Self {
            bind_addr: parse("RELAY_BIND", get("RELAY_BIND"), SocketAddr::from(([0, 0, 0, 0], 8787)))?,
            google_client_ids: get("GOOGLE_CLIENT_ID")
                .map(|v| v.split(',').map(str::trim).filter(|id| !id.is_empty()).map(str::to_owned).collect::<Vec<_>>())
                .filter(|ids| !ids.is_empty())
                .ok_or(ConfigError::Missing("GOOGLE_CLIENT_ID"))?,
            max_frame_bytes: parse("RELAY_MAX_FRAME_BYTES", get("RELAY_MAX_FRAME_BYTES"), DEFAULT_MAX_FRAME_BYTES)?,
            channel_capacity: parse("RELAY_CHANNEL_CAPACITY", get("RELAY_CHANNEL_CAPACITY"), 32)?,
            max_connections_per_account: parse(
                "RELAY_MAX_CONNECTIONS_PER_ACCOUNT",
                get("RELAY_MAX_CONNECTIONS_PER_ACCOUNT"),
                8,
            )?,
            idle_timeout_secs: parse("RELAY_IDLE_TIMEOUT_SECS", get("RELAY_IDLE_TIMEOUT_SECS"), 60)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect();
        move |key| map.get(key).cloned()
    }

    #[test]
    fn uses_defaults() {
        let config = Config::from_lookup(lookup(&[("GOOGLE_CLIENT_ID", "client")])).unwrap();
        assert_eq!(config.bind_addr.port(), 8787);
        assert_eq!(config.max_frame_bytes, DEFAULT_MAX_FRAME_BYTES);
        assert_eq!(config.channel_capacity, 32);
        assert_eq!(config.max_connections_per_account, 8);
        assert_eq!(config.idle_timeout_secs, 60);
    }

    #[test]
    fn accepts_several_client_ids() {
        let config = Config::from_lookup(lookup(&[("GOOGLE_CLIENT_ID", "desktop-id, web-id,")])).unwrap();
        assert_eq!(config.google_client_ids, ["desktop-id", "web-id"]);
    }

    #[test]
    fn requires_a_client_id() {
        assert!(matches!(Config::from_lookup(lookup(&[])), Err(ConfigError::Missing("GOOGLE_CLIENT_ID"))));
    }

    #[test]
    fn rejects_invalid_numbers() {
        let result = Config::from_lookup(lookup(&[("GOOGLE_CLIENT_ID", "c"), ("RELAY_CHANNEL_CAPACITY", "many")]));
        assert!(matches!(result, Err(ConfigError::Invalid("RELAY_CHANNEL_CAPACITY", _))));
    }
}

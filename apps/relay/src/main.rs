use std::sync::Arc;

use ankylock_relay::auth::{GoogleAuthenticator, GoogleJwksSource};
use ankylock_relay::config::Config;
use ankylock_relay::hub::Hub;
use ankylock_relay::{app, RelayState};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let config = Config::from_env()?;
    let state = Arc::new(RelayState {
        hub: Hub::new(config.channel_capacity, config.max_connections_per_account),
        authenticator: Box::new(GoogleAuthenticator::new(config.google_client_ids, GoogleJwksSource::new())),
        max_frame_bytes: config.max_frame_bytes,
        idle_timeout: std::time::Duration::from_secs(config.idle_timeout_secs),
    });

    let listener = tokio::net::TcpListener::bind(config.bind_addr).await?;
    tracing::info!(addr = %config.bind_addr, "relay listening");
    axum::serve(listener, app(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

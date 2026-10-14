//! Stateless blind WebSocket relay: authenticates connections, then fans opaque binary frames
//! out to the other devices on the same account and vault. It stores nothing and never reads frame bodies.

pub mod auth;
pub mod config;
pub mod hub;
pub mod ws;

use std::sync::Arc;

use axum::routing::get;
use axum::Router;

pub use ws::RelayState;

pub fn app(state: Arc<RelayState>) -> Router {
    Router::new()
        .route("/ws/{vault}", get(ws::ws_handler))
        .route("/healthz", get(|| async { "ok" }))
        .with_state(state)
}

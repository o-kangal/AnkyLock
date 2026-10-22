use std::sync::Arc;

use axum::extract::ws::{CloseFrame, Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::broadcast::error::RecvError;

use crate::auth::Authenticator;
use crate::hub::{Channel, Frame, Hub, VaultId};

/// Subprotocol the client offers first; the second offered value is the bearer token, because
/// browsers cannot set headers on WebSocket requests and URLs end up in logs.
pub const SUBPROTOCOL: &str = "ankylock.v1";
/// Text control frames; only binary frames are forwarded between peers.
pub const PING: &str = "ping";
pub const PONG: &str = "pong";
/// Close code sent to a client that fell too far behind; it reconnects and resyncs.
pub const CLOSE_LAGGED: u16 = 4001;
const CLOSE_TOO_BIG: u16 = 1009;
/// Policy violation: the account already has its maximum of open connections.
pub const CLOSE_TOO_MANY: u16 = 1008;
/// The connection stayed silent (no frame, no ping) for longer than the idle timeout.
pub const CLOSE_IDLE: u16 = 4002;

pub struct RelayState {
    pub hub: Hub,
    pub authenticator: Box<dyn Authenticator>,
    pub max_frame_bytes: usize,
    pub idle_timeout: std::time::Duration,
}

/// Extracts the token from `Sec-WebSocket-Protocol: ankylock.v1, <token>`.
fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let offered = headers.get("sec-websocket-protocol")?.to_str().ok()?;
    let mut parts = offered.split(',').map(str::trim);
    (parts.next()? == SUBPROTOCOL).then_some(())?;
    parts.next().filter(|token| !token.is_empty())
}

/// Authenticates before upgrading: unauthenticated requests never get a socket. The path names
/// the vault (`/ws/<vaultId>`), which scopes the fanout within the account.
pub async fn ws_handler(
    State(state): State<Arc<RelayState>>,
    Path(vault): Path<String>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let Some(vault) = VaultId::parse(&vault) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(token) = bearer_token(&headers) else {
        return StatusCode::UNAUTHORIZED.into_response();
    };
    let account = match state.authenticator.authenticate(token).await {
        Ok(account) => account,
        Err(error) => {
            tracing::info!(%error, "rejected websocket upgrade");
            return StatusCode::UNAUTHORIZED.into_response();
        }
    };
    let max = state.max_frame_bytes;
    upgrade
        .protocols([SUBPROTOCOL])
        .max_message_size(max)
        .max_frame_size(max)
        .on_upgrade(move |socket| relay(socket, state, Channel { account, vault }))
}

/// Forwards every binary frame unchanged to the channel's other connections. Frame bodies
/// are never parsed or logged; only connection lifecycle and sizes are.
async fn relay(mut socket: WebSocket, state: Arc<RelayState>, channel: Channel) {
    let Some(mut subscription) = state.hub.join(&channel) else {
        tracing::warn!("too many connections for one account; closing");
        let close = CloseFrame { code: CLOSE_TOO_MANY, reason: Utf8Bytes::from_static("too many connections") };
        let _ = socket.send(Message::Close(Some(close))).await;
        return;
    };
    let id = subscription.id;
    tracing::info!(connection = id, "connected");
    let (mut outgoing, mut incoming) = socket.split();
    let idle = tokio::time::sleep(state.idle_timeout);
    tokio::pin!(idle);

    let close_reason = loop {
        tokio::select! {
            () = &mut idle => break Some((CLOSE_IDLE, "idle")),
            message = incoming.next() => match message {
                Some(Ok(Message::Binary(data))) => {
                    idle.as_mut().reset(tokio::time::Instant::now() + state.idle_timeout);
                    if data.len() > state.max_frame_bytes {
                        break Some((CLOSE_TOO_BIG, "frame too large"));
                    }
                    // No receivers is fine: the sender may be the only device online.
                    let _ = subscription.sender.send(Frame { sender: id, data });
                }
                Some(Ok(Message::Text(text))) if text.as_str() == PING => {
                    idle.as_mut().reset(tokio::time::Instant::now() + state.idle_timeout);
                    if outgoing.send(Message::Text(Utf8Bytes::from_static(PONG))).await.is_err() {
                        break None;
                    }
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break None,
                // Other text frames and protocol-level pings are not relayed.
                Some(Ok(_)) => {}
            },
            frame = subscription.receiver.recv() => match frame {
                Ok(frame) if frame.sender == id => {}
                Ok(frame) => {
                    if outgoing.send(Message::Binary(frame.data)).await.is_err() {
                        break None;
                    }
                }
                Err(RecvError::Lagged(skipped)) => {
                    tracing::warn!(connection = id, skipped, "client lagged; closing");
                    break Some((CLOSE_LAGGED, "lagged; reconnect to resync"));
                }
                Err(RecvError::Closed) => break None,
            },
        }
    };

    if let Some((code, reason)) = close_reason {
        let close = CloseFrame { code, reason: Utf8Bytes::from_static(reason) };
        let _ = outgoing.send(Message::Close(Some(close))).await;
    }
    state.hub.leave(&channel, subscription);
    tracing::info!(connection = id, "disconnected");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("sec-websocket-protocol", HeaderValue::from_str(value).unwrap());
        headers
    }

    #[test]
    fn reads_the_token_after_the_subprotocol() {
        assert_eq!(bearer_token(&headers("ankylock.v1, abc.def.ghi")), Some("abc.def.ghi"));
        assert_eq!(bearer_token(&headers("ankylock.v1,abc")), Some("abc"));
    }

    #[test]
    fn rejects_missing_or_foreign_subprotocols() {
        assert_eq!(bearer_token(&HeaderMap::new()), None);
        assert_eq!(bearer_token(&headers("ankylock.v1")), None);
        assert_eq!(bearer_token(&headers("ankylock.v1, ")), None);
        assert_eq!(bearer_token(&headers("chat, abc")), None);
    }
}

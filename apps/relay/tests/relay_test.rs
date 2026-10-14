use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use ankylock_relay::auth::{AccountId, AuthError, Authenticator, BoxFuture};
use ankylock_relay::hub::Hub;
use ankylock_relay::{app, RelayState};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Client = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Tokens of the form `token-<account>` authenticate as `<account>`.
struct StaticAuthenticator;

impl Authenticator for StaticAuthenticator {
    fn authenticate<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<AccountId, AuthError>> {
        Box::pin(async move {
            token
                .strip_prefix("token-")
                .map(|account| AccountId(account.into()))
                .ok_or_else(|| AuthError::Invalid("unknown token".into()))
        })
    }
}

async fn start(max_frame_bytes: usize) -> (SocketAddr, Arc<RelayState>) {
    let state = Arc::new(RelayState {
        hub: Hub::new(64),
        authenticator: Box::new(StaticAuthenticator),
        max_frame_bytes,
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app(state.clone());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (addr, state)
}

const VAULT: &str = "0b6f5c2e-3d1a-4c8e-9f7b-2a1d4e5f6a7b";

async fn connect(addr: SocketAddr, protocol: &str) -> Result<Client, WsError> {
    connect_to(addr, VAULT, protocol).await
}

async fn connect_to(addr: SocketAddr, vault: &str, protocol: &str) -> Result<Client, WsError> {
    let mut request = format!("ws://{addr}/ws/{vault}").into_client_request().unwrap();
    request.headers_mut().insert("sec-websocket-protocol", protocol.parse().unwrap());
    connect_async(request).await.map(|(stream, response)| {
        assert_eq!(response.headers().get("sec-websocket-protocol").unwrap(), "ankylock.v1");
        stream
    })
}

async fn client(addr: SocketAddr, account: &str) -> Client {
    connect(addr, &format!("ankylock.v1, token-{account}")).await.unwrap()
}

/// Next message, or None if nothing arrives within 300 ms.
async fn next(client: &mut Client) -> Option<Message> {
    tokio::time::timeout(Duration::from_millis(300), client.next()).await.ok().flatten().map(Result::unwrap)
}

fn status(error: WsError) -> u16 {
    match error {
        WsError::Http(response) => response.status().as_u16(),
        other => panic!("expected an HTTP rejection, got {other:?}"),
    }
}

#[tokio::test]
async fn rejects_unauthenticated_upgrades() {
    let (addr, _) = start(1024).await;
    assert_eq!(status(connect(addr, "ankylock.v1, bad-token").await.unwrap_err()), 401);
    assert_eq!(status(connect(addr, "ankylock.v1").await.unwrap_err()), 401);
    assert_eq!(status(connect(addr, "chat, token-a").await.unwrap_err()), 401);
}

#[tokio::test]
async fn forwards_frames_byte_for_byte_to_same_account_peers_only() {
    let (addr, _) = start(1024 * 1024).await;
    let mut a1 = client(addr, "alice").await;
    let mut a2 = client(addr, "alice").await;
    let mut a3 = client(addr, "alice").await;
    let mut b1 = client(addr, "bob").await;

    let frame: Vec<u8> = (0..=255u8).cycle().take(4096).collect();
    a1.send(Message::Binary(frame.clone().into())).await.unwrap();

    for peer in [&mut a2, &mut a3] {
        match next(peer).await {
            Some(Message::Binary(data)) => assert_eq!(data.as_ref(), frame.as_slice()),
            other => panic!("expected the binary frame, got {other:?}"),
        }
    }
    assert_eq!(next(&mut a1).await, None, "sender must not receive its own frame");
    assert_eq!(next(&mut b1).await, None, "other accounts must not receive the frame");
}

#[tokio::test]
async fn keeps_vaults_of_one_account_apart() {
    let (addr, _) = start(1024).await;
    let mut work1 = client(addr, "alice").await;
    let mut work2 = client(addr, "alice").await;
    let mut personal = connect_to(addr, "1c7e9d3a-5b2f-4a6e-8d1c-3f5a7b9e2d4c", "ankylock.v1, token-alice").await.unwrap();
    work1.send(Message::Binary(vec![7u8; 8].into())).await.unwrap();
    assert!(matches!(next(&mut work2).await, Some(Message::Binary(_))));
    assert_eq!(next(&mut personal).await, None, "another vault must not receive the frame");
}

#[tokio::test]
async fn rejects_malformed_vault_ids() {
    let (addr, _) = start(1024).await;
    assert_eq!(status(connect_to(addr, "not%20a%20vault", "ankylock.v1, token-alice").await.unwrap_err()), 400);
}

#[tokio::test]
async fn answers_ping_itself_and_never_forwards_text() {
    let (addr, _) = start(1024).await;
    let mut a1 = client(addr, "alice").await;
    let mut a2 = client(addr, "alice").await;

    a1.send(Message::Text("ping".into())).await.unwrap();
    assert_eq!(next(&mut a1).await, Some(Message::Text("pong".into())));
    a1.send(Message::Text("hello".into())).await.unwrap();
    assert_eq!(next(&mut a2).await, None);
}

#[tokio::test]
async fn closes_connections_that_send_oversized_frames() {
    let (addr, _) = start(1024).await;
    let mut a1 = client(addr, "alice").await;
    let mut a2 = client(addr, "alice").await;
    let _ = a1.send(Message::Binary(vec![0u8; 4096].into())).await;

    // The server either sends close 1009 or drops the connection outright; both are fine.
    match tokio::time::timeout(Duration::from_secs(2), a1.next()).await {
        Ok(Some(Ok(Message::Close(Some(frame))))) => assert_eq!(frame.code, CloseCode::Size),
        Ok(Some(Ok(Message::Close(None))) | Some(Err(_)) | None) => {}
        other => panic!("expected the connection to close, got {other:?}"),
    }
    let _ = a1.send(Message::Text("ping".into())).await;
    assert!(!matches!(a1.next().await, Some(Ok(Message::Text(_)))), "closed connection must not answer");
    assert_eq!(next(&mut a2).await, None);
}

#[tokio::test]
async fn releases_account_channels_when_everyone_disconnects() {
    let (addr, state) = start(1024).await;
    let mut a1 = client(addr, "alice").await;
    let mut a2 = client(addr, "alice").await;
    assert_eq!(state.hub.channel_count(), 1);
    a1.close(None).await.unwrap();
    a2.close(None).await.unwrap();
    for _ in 0..50 {
        if state.hub.channel_count() == 0 {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("account channel was not released");
}

#[tokio::test]
async fn serves_a_health_check() {
    let (addr, _) = start(1024).await;
    let mut stream = TcpStream::connect(addr).await.unwrap();
    tokio::io::AsyncWriteExt::write_all(&mut stream, b"GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut body = String::new();
    tokio::io::AsyncReadExt::read_to_string(&mut stream, &mut body).await.unwrap();
    assert!(body.starts_with("HTTP/1.1 200"));
    assert!(body.ends_with("ok"));
}

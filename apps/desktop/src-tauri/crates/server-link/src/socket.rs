//! Minimal Socket.IO v4 client (WebSocket transport only), over the pinned TLS connection.
//!
//! The browser view cannot pin a self-signed certificate, so the realtime link lives here.
//! Protocol used (Engine.IO 4 / Socket.IO 5 packets):
//!   server -> "0{...}" open        client -> "40{auth}" connect namespace "/"
//!   server -> "40{...}" connected  server -> "44{...}" connection refused (bad token)
//!   server -> "2" ping             client -> "3" pong
//!   server -> "42[\"changed\",{...}]" event
//!   server -> "41" disconnected by the server

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use rustls::pki_types::ServerName;
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::{LinkError, Server};

/// Longest silence accepted: the server pings every 20 seconds.
const SILENCE_LIMIT: Duration = Duration::from_secs(50);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SocketEvent {
    Connected,
    /// A change signal: the client refetches what it shows for this topic.
    Changed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SocketEnd {
    /// The server refused the token (expired or session ended).
    Unauthorized,
    /// Connection lost or closed: try again later.
    Lost(String),
}

/// Parses one text frame. Returns (reply to send, event to report).
pub fn handle_frame(frame: &str, token: &str) -> Result<(Option<String>, Option<SocketEvent>), SocketEnd> {
    if frame == "2" {
        return Ok((Some("3".into()), None));
    }
    if let Some(rest) = frame.strip_prefix("0{") {
        let _ = rest;
        let auth = serde_json::json!({ "token": token });
        return Ok((Some(format!("40{auth}")), None));
    }
    if frame.starts_with("40") {
        return Ok((None, Some(SocketEvent::Connected)));
    }
    if frame.starts_with("44") {
        return Err(SocketEnd::Unauthorized);
    }
    if frame.starts_with("41") || frame == "1" {
        return Err(SocketEnd::Lost("closed by server".into()));
    }
    if let Some(payload) = frame.strip_prefix("42") {
        if let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(payload) {
            if items.first().and_then(|v| v.as_str()) == Some("changed") {
                if let Some(topic) = items.get(1).and_then(|v| v.get("topic")).and_then(|v| v.as_str()) {
                    return Ok((None, Some(SocketEvent::Changed(topic.to_string()))));
                }
            }
        }
    }
    Ok((None, None))
}

/// Connects and runs until the link ends. `on_event` is called for each event.
pub async fn run(server: &Server, token: &str, mut on_event: impl FnMut(SocketEvent)) -> SocketEnd {
    match run_inner(server, token, &mut on_event).await {
        Ok(end) => end,
        Err(e) => SocketEnd::Lost(e.to_string()),
    }
}

async fn run_inner(server: &Server, token: &str, on_event: &mut impl FnMut(SocketEvent)) -> Result<SocketEnd, LinkError> {
    let base = server.base();
    let host = base.host_str().ok_or(LinkError::InvalidAddress)?.to_string();
    let port = base.port_or_known_default().ok_or(LinkError::InvalidAddress)?;
    let unreachable = |e: &dyn std::fmt::Display| LinkError::Unreachable { detail: e.to_string() };

    let tcp = timeout(Duration::from_secs(5), TcpStream::connect((host.as_str(), port)))
        .await
        .map_err(|e| unreachable(&e))?
        .map_err(|e| unreachable(&e))?;
    let name = ServerName::try_from(host.clone()).map_err(|_| LinkError::InvalidAddress)?;
    let tls = TlsConnector::from(Arc::new(server.tls()?))
        .connect(name, tcp)
        .await
        .map_err(|e| unreachable(&e))?;

    let url = format!("wss://{host}:{port}/socket.io/?EIO=4&transport=websocket");
    let request = url.into_client_request().map_err(|e| unreachable(&e))?;
    let (mut ws, _) = tokio_tungstenite::client_async(request, tls).await.map_err(|e| unreachable(&e))?;

    loop {
        let next = match timeout(SILENCE_LIMIT, ws.next()).await {
            Ok(Some(Ok(msg))) => msg,
            Ok(Some(Err(e))) => return Ok(SocketEnd::Lost(e.to_string())),
            Ok(None) => return Ok(SocketEnd::Lost("closed".into())),
            Err(_) => return Ok(SocketEnd::Lost("no ping from server".into())),
        };
        match next {
            Message::Text(text) => match handle_frame(text.as_str(), token) {
                Ok((reply, event)) => {
                    if let Some(reply) = reply {
                        if let Err(e) = ws.send(Message::Text(reply.into())).await {
                            return Ok(SocketEnd::Lost(e.to_string()));
                        }
                    }
                    if let Some(event) = event {
                        on_event(event);
                    }
                }
                Err(end) => return Ok(end),
            },
            Message::Close(_) => return Ok(SocketEnd::Lost("closed".into())),
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_the_socket_io_handshake() {
        let (reply, event) = handle_frame(r#"0{"sid":"x","pingInterval":20000}"#, "tok").unwrap();
        assert_eq!(reply.as_deref(), Some(r#"40{"token":"tok"}"#));
        assert_eq!(event, None);
        assert_eq!(handle_frame(r#"40{"sid":"y"}"#, "tok").unwrap(), (None, Some(SocketEvent::Connected)));
        assert_eq!(handle_frame("2", "tok").unwrap(), (Some("3".into()), None));
    }

    #[test]
    fn reports_change_signals_and_refusals() {
        let (_, event) = handle_frame(r#"42["changed",{"topic":"messages"}]"#, "tok").unwrap();
        assert_eq!(event, Some(SocketEvent::Changed("messages".into())));
        assert_eq!(handle_frame(r#"42["other",{}]"#, "tok").unwrap(), (None, None));
        assert_eq!(handle_frame(r#"44{"message":"UNAUTHENTICATED"}"#, "tok"), Err(SocketEnd::Unauthorized));
        assert!(matches!(handle_frame("41", "tok"), Err(SocketEnd::Lost(_))));
    }
}

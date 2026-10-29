// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Desktop shell. All traffic to the server goes through Rust (pinned certificate). Tokens stay
//! here, never in the web view. The UI talks to these commands through src/adapters/tauri.ts.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use server_link::socket::{SocketEnd, SocketEvent};
use server_link::{Health, LinkError, Probe, Server};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");
const EVENT_CHANGED: &str = "alyassir://changed";
const EVENT_LINK: &str = "alyassir://link";
const EVENT_SESSION_ENDED: &str = "alyassir://session-ended";

/// The confirmed server, saved on this computer (SPEC 6.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedServer {
    url: String,
    fingerprint: String,
}

struct Tokens {
    access: String,
    refresh: String,
    access_valid_until: Instant,
}

#[derive(Default)]
struct Session {
    server: Option<Server>,
    tokens: Option<Tokens>,
    socket: Option<tauri::async_runtime::JoinHandle<()>>,
}

type Shared = Arc<Mutex<Session>>;

fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("server.json"))
}

fn load(app: &AppHandle) -> Option<SavedServer> {
    let text = fs::read_to_string(config_file(app).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_else(|_| "unknown".into())
}

fn headers(access: Option<&str>, user_active: bool) -> Vec<(String, String)> {
    let mut h = vec![
        ("x-alyassir-client-version".into(), CLIENT_VERSION.into()),
        ("x-alyassir-device".into(), device_name()),
        ("x-alyassir-user-active".into(), if user_active { "1" } else { "0" }.into()),
    ];
    if let Some(token) = access {
        h.push(("authorization".into(), format!("Bearer {token}")));
    }
    h
}

/// Network problems become the same { code } shape as API errors, for the UI.
fn link_error(e: LinkError) -> Value {
    match e {
        LinkError::FingerprintMismatch { seen } => json!({ "code": "FINGERPRINT_MISMATCH", "seen": seen }),
        LinkError::Unreachable { .. } => json!({ "code": "NETWORK" }),
        _ => json!({ "code": "NETWORK" }),
    }
}

fn tokens_from(body: &Value) -> Option<Tokens> {
    let access = body.get("accessToken")?.as_str()?.to_string();
    let refresh = body.get("refreshToken")?.as_str()?.to_string();
    let secs = body.get("accessTokenExpiresIn").and_then(|v| v.as_u64()).unwrap_or(900);
    // Refresh a little before the server would refuse the token.
    let valid = Duration::from_secs(secs.saturating_sub(60).max(30));
    Some(Tokens { access, refresh, access_valid_until: Instant::now() + valid })
}

fn server_for(app: &AppHandle) -> Result<Server, Value> {
    let saved = load(app).ok_or_else(|| json!({ "code": "NETWORK" }))?;
    Server::new(&saved.url, &saved.fingerprint).map_err(link_error)
}

/// Opens a WhatsApp link (SPEC 18.4: a wa.me link only, nothing is sent by the program) in the
/// default browser. Only https://wa.me/<digits>?text=<encoded> is accepted.
#[tauri::command]
fn open_whatsapp(url: String) -> Result<(), String> {
    let rest = url.strip_prefix("https://wa.me/").ok_or("not a wa.me link")?;
    let (number, query) = rest.split_once('?').unwrap_or((rest, ""));
    let safe_query = query.chars().all(|c| c.is_ascii_alphanumeric() || "%=&-_.~".contains(c));
    if number.is_empty() || !number.chars().all(|c| c.is_ascii_digit()) || !safe_query {
        return Err("not a wa.me link".into());
    }
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", &url]).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&url).spawn();
    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Saves a report file (Excel) in the Downloads folder of the computer and returns its full path.
/// Only plain file names ending in .xlsx; an existing file is never replaced (a number is added).
#[tauri::command]
fn save_download(app: AppHandle, file_name: String, data: Vec<u8>) -> Result<String, String> {
    let safe = !file_name.is_empty()
        && file_name.len() <= 100
        && file_name.ends_with(".xlsx")
        && file_name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        && !file_name.starts_with('.');
    if !safe {
        return Err("invalid file name".into());
    }
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = file_name.trim_end_matches(".xlsx");
    let mut path = dir.join(&file_name);
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).xlsx"));
        n += 1;
    }
    fs::write(&path, data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn probe_server(address: String) -> Result<Probe, LinkError> {
    server_link::probe(&address).await
}

#[tauri::command]
async fn check_server(app: AppHandle) -> Result<Health, LinkError> {
    let saved = load(&app).ok_or(LinkError::InvalidAddress)?;
    server_link::check(&saved.url, &saved.fingerprint).await
}

#[tauri::command]
fn load_server(app: AppHandle) -> Option<SavedServer> {
    load(&app)
}

#[tauri::command]
fn save_server(app: AppHandle, url: String, fingerprint: String) -> Result<(), String> {
    server_link::normalize_address(&url).map_err(|e| e.to_string())?;
    server_link::parse_fingerprint(&fingerprint).ok_or("invalid fingerprint")?;
    let json = serde_json::to_string_pretty(&SavedServer { url, fingerprint }).map_err(|e| e.to_string())?;
    fs::write(config_file(&app)?, json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn api_login(app: AppHandle, state: State<'_, Shared>, username: String, password: String) -> Result<Value, Value> {
    let server = server_for(&app)?;
    let body = json!({ "username": username, "password": password });
    let reply = server.send("POST", "/api/auth/login", Some(&body), &headers(None, true)).await.map_err(link_error)?;
    if reply.status != 200 {
        return Err(reply.body);
    }
    let tokens = tokens_from(&reply.body).ok_or_else(|| json!({ "code": "INTERNAL" }))?;
    let mut session = state.lock().await;
    if let Some(old) = session.socket.take() {
        old.abort();
    }
    session.server = Some(server);
    session.tokens = Some(tokens);
    session.socket = Some(spawn_socket(app.clone(), state.inner().clone()));
    let mut body = reply.body;
    // Tokens stay in Rust.
    if let Some(obj) = body.as_object_mut() {
        obj.remove("accessToken");
        obj.remove("refreshToken");
    }
    Ok(body)
}

async fn end_session(app: &AppHandle, shared: &Shared, code: &str) {
    let mut session = shared.lock().await;
    session.tokens = None;
    if let Some(task) = session.socket.take() {
        task.abort();
    }
    let _ = app.emit(EVENT_SESSION_ENDED, json!({ "code": code }));
}

#[tauri::command]
async fn api_logout(state: State<'_, Shared>) -> Result<(), Value> {
    let (server, access) = {
        let mut session = state.lock().await;
        if let Some(task) = session.socket.take() {
            task.abort();
        }
        let access = session.tokens.take().map(|t| t.access);
        (session.server.clone(), access)
    };
    if let (Some(server), Some(access)) = (server, access) {
        let _ = server.send("POST", "/api/auth/logout", None, &headers(Some(&access), true)).await;
    }
    Ok(())
}

/// Returns a valid access token, refreshing it when needed. None = the session is over.
async fn access_token(shared: &Shared, force_refresh: bool) -> Result<(Server, String), String> {
    let mut session = shared.lock().await;
    let server = session.server.clone().ok_or("UNAUTHENTICATED")?;
    let tokens = session.tokens.as_ref().ok_or("UNAUTHENTICATED")?;
    if !force_refresh && Instant::now() < tokens.access_valid_until {
        return Ok((server, tokens.access.clone()));
    }
    let body = json!({ "refreshToken": tokens.refresh });
    let reply = server.send("POST", "/api/auth/refresh", Some(&body), &headers(None, false)).await.map_err(|_| "NETWORK")?;
    if reply.status != 200 {
        session.tokens = None;
        let code = reply.body.get("code").and_then(|c| c.as_str()).unwrap_or("UNAUTHENTICATED").to_string();
        return Err(code);
    }
    let tokens = tokens_from(&reply.body).ok_or("UNAUTHENTICATED")?;
    let access = tokens.access.clone();
    session.tokens = Some(tokens);
    Ok((server, access))
}

#[tauri::command]
async fn api_request(
    app: AppHandle,
    state: State<'_, Shared>,
    method: String,
    path: String,
    body: Option<Value>,
    user_active: bool,
) -> Result<Value, Value> {
    let shared = state.inner().clone();
    let mut refreshed = false;
    loop {
        let (server, access) = match access_token(&shared, false).await {
            Ok(v) => v,
            Err(code) if code == "NETWORK" => return Err(json!({ "code": "NETWORK" })),
            Err(code) => {
                end_session(&app, &shared, &code).await;
                return Err(json!({ "code": code }));
            }
        };
        let reply = server.send(&method, &path, body.as_ref(), &headers(Some(&access), user_active)).await.map_err(link_error)?;
        if reply.status == 401 {
            let code = reply.body.get("code").and_then(|c| c.as_str()).unwrap_or("UNAUTHENTICATED").to_string();
            // An expired access token: refresh once and retry. Any other 401 ends the session.
            if code == "UNAUTHENTICATED" && !refreshed {
                refreshed = true;
                match access_token(&shared, true).await {
                    Ok(_) => continue,
                    Err(code) => {
                        end_session(&app, &shared, &code).await;
                        return Err(json!({ "code": code }));
                    }
                }
            }
            end_session(&app, &shared, &code).await;
            return Err(reply.body);
        }
        if reply.status == 403 && reply.body.get("code").and_then(|c| c.as_str()) == Some("ACCOUNT_DISABLED") {
            end_session(&app, &shared, "ACCOUNT_DISABLED").await;
        }
        if reply.status >= 400 {
            return Err(reply.body);
        }
        return Ok(reply.body);
    }
}

/// Keeps the realtime link up for the whole session, reconnecting after any loss (SPEC 3.2).
fn spawn_socket(app: AppHandle, shared: Shared) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut force_refresh = false;
        loop {
            let (server, token) = match access_token(&shared, force_refresh).await {
                Ok(v) => v,
                Err(code) if code == "NETWORK" => {
                    let _ = app.emit(EVENT_LINK, json!({ "state": "disconnected" }));
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    continue;
                }
                Err(code) => {
                    // The session is over (idle time, disabled account...): tell the UI and stop.
                    {
                        let mut session = shared.lock().await;
                        session.tokens = None;
                        session.socket = None;
                    }
                    let _ = app.emit(EVENT_SESSION_ENDED, json!({ "code": code }));
                    return;
                }
            };
            let emitter = app.clone();
            let end = server_link::socket::run(&server, &token, move |event| match event {
                // After a (re)connection the UI refetches everything it shows.
                SocketEvent::Connected => {
                    let _ = emitter.emit(EVENT_LINK, json!({ "state": "connected" }));
                }
                SocketEvent::Changed(topic) => {
                    let _ = emitter.emit(EVENT_CHANGED, json!({ "topic": topic }));
                }
            })
            .await;
            let _ = app.emit(EVENT_LINK, json!({ "state": "disconnected" }));
            force_refresh = end == SocketEnd::Unauthorized;
            tokio::time::sleep(Duration::from_secs(if force_refresh { 1 } else { 3 })).await;
        }
    })
}

fn main() {
    tauri::Builder::default()
        .manage(Shared::default())
        .invoke_handler(tauri::generate_handler![
            probe_server,
            check_server,
            load_server,
            save_server,
            api_login,
            api_logout,
            api_request,
            open_whatsapp,
            save_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running Alyassir");
}

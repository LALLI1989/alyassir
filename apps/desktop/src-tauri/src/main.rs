// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use server_link::{Health, LinkError, Probe};
use tauri::{AppHandle, Manager};

/// The confirmed server, saved on this computer (SPEC 6.2).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedServer {
    url: String,
    fingerprint: String,
}

fn config_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("server.json"))
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

fn load(app: &AppHandle) -> Option<SavedServer> {
    let text = fs::read_to_string(config_file(app).ok()?).ok()?;
    serde_json::from_str(&text).ok()
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe_server, check_server, load_server, save_server])
        .run(tauri::generate_context!())
        .expect("error while running Alyassir");
}

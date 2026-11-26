//! Borderless, click-through overlay shown over VALORANT during agent select.
//!
//! The window is a normal always-on-top Tauri window (no injection, no game
//! memory access). It is click-through so the game keeps receiving input; the
//! webview polls the cursor position and hit-tests its own rows to show the
//! hovered player's inventory.
//!
//! A small watcher reads the local presence loop state (`MENUS`, `PREGAME`,
//! `INGAME`) and shows the overlay when agent select starts, hiding it again
//! when the match leaves that phase. The global hotkey toggles it manually.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::header::AUTHORIZATION;
use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{
    AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::live_match::read_lockfile;

pub const OVERLAY_LABEL: &str = "overlay";
const OVERLAY_WIDTH: f64 = 1080.0;
const OVERLAY_HEIGHT: f64 = 520.0;

/// Auto-show at agent select (pushed from the UI setting).
static AUTO_SHOW: AtomicBool = AtomicBool::new(true);
/// True while the overlay is visible because the watcher showed it.
static AUTO_SHOWN: AtomicBool = AtomicBool::new(false);
/// True after a manual toggle; the watcher must not hide it automatically.
static MANUAL: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorPosition {
    pub x: f64,
    pub y: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPhase {
    pub phase: String,
}

fn center_on_cursor_monitor(app: &AppHandle, window: &WebviewWindow) {
    let Ok(size) = window.outer_size() else {
        return;
    };
    let monitor = app
        .cursor_position()
        .ok()
        .and_then(|cursor| app.monitor_from_point(cursor.x, cursor.y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return;
    };
    let origin = monitor.position();
    let screen = monitor.size();
    let x = origin.x + (screen.width as i32 - size.width as i32) / 2;
    let y = origin.y + (screen.height as i32 - size.height as i32) / 2;
    let _ = window.set_position(PhysicalPosition::new(x, y));
}

fn build(app: &AppHandle) -> Result<WebviewWindow, String> {
    let window = WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
        .title("2009 tracker overlay")
        .inner_size(OVERLAY_WIDTH, OVERLAY_HEIGHT)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focusable(false)
        .visible(false)
        .build()
        .map_err(|e| format!("オーバーレイを開けませんでした: {e}"))?;

    // Clicks belong to the game; the UI hit-tests the cursor itself.
    let _ = window.set_ignore_cursor_events(true);
    center_on_cursor_monitor(app, &window);
    Ok(window)
}

pub(crate) fn show(app: &AppHandle) -> Result<(), String> {
    let window = match app.get_webview_window(OVERLAY_LABEL) {
        Some(window) => window,
        None => build(app)?,
    };
    center_on_cursor_monitor(app, &window);
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_always_on_top(true);
    Ok(())
}

pub(crate) fn hide(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn toggle(app: &AppHandle) -> Result<bool, String> {
    MANUAL.store(true, Ordering::Relaxed);
    let visible = app
        .get_webview_window(OVERLAY_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if visible {
        AUTO_SHOWN.store(false, Ordering::Relaxed);
        hide(app)?;
        Ok(false)
    } else {
        show(app)?;
        Ok(true)
    }
}

#[tauri::command]
pub fn overlay_show(app: AppHandle) -> Result<(), String> {
    MANUAL.store(true, Ordering::Relaxed);
    show(&app)
}

#[tauri::command]
pub fn overlay_hide(app: AppHandle) -> Result<(), String> {
    MANUAL.store(true, Ordering::Relaxed);
    AUTO_SHOWN.store(false, Ordering::Relaxed);
    hide(&app)
}

#[tauri::command]
pub fn overlay_toggle(app: AppHandle) -> Result<bool, String> {
    toggle(&app)
}

#[tauri::command]
pub fn overlay_is_visible(app: AppHandle) -> bool {
    app.get_webview_window(OVERLAY_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

#[tauri::command]
pub fn overlay_set_auto_show(enabled: bool) {
    AUTO_SHOW.store(enabled, Ordering::Relaxed);
}

/// Cursor position in the overlay webview's CSS pixels, or `None` while the
/// overlay is hidden. Used for hover hit-testing because the window itself is
/// click-through.
#[tauri::command]
pub fn overlay_cursor(app: AppHandle) -> Result<Option<CursorPosition>, String> {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        return Ok(None);
    };
    if !window.is_visible().unwrap_or(false) {
        return Ok(None);
    }
    let cursor = app.cursor_position().map_err(|e| e.to_string())?;
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    if scale <= 0.0 {
        return Ok(None);
    }
    Ok(Some(CursorPosition {
        x: (cursor.x - position.x as f64) / scale,
        y: (cursor.y - position.y as f64) / scale,
    }))
}

/// Reads the local presence feed and returns the client's `sessionLoopState`
/// (`MENUS`, `PREGAME`, `INGAME`, ...). Empty when the client is not running.
pub async fn current_loop_state() -> Option<String> {
    let lock = read_lockfile()?;
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(3))
        .build()
        .ok()?;
    let basic = BASE64.encode(format!("riot:{}", lock.password));

    let token: Value = client
        .get(format!(
            "https://127.0.0.1:{}/entitlements/v1/token",
            lock.port
        ))
        .header(AUTHORIZATION, format!("Basic {basic}"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let puuid = token.get("subject")?.as_str()?.to_lowercase();

    let presences: Value = client
        .get(format!("https://127.0.0.1:{}/chat/v4/presences", lock.port))
        .header(AUTHORIZATION, format!("Basic {basic}"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    let list = presences.get("presences")?.as_array()?;
    let me = list.iter().find(|entry| {
        entry
            .get("puuid")
            .and_then(|v| v.as_str())
            .map(|value| value.eq_ignore_ascii_case(&puuid))
            .unwrap_or(false)
    })?;
    let private = me.get("private")?.as_str()?;
    let bytes = BASE64.decode(private).ok()?;
    let decoded: Value = serde_json::from_slice(&bytes).ok()?;
    decoded
        .get("matchPresenceData")
        .and_then(|data| data.get("sessionLoopState"))
        .or_else(|| decoded.get("sessionLoopState"))
        .and_then(|value| value.as_str())
        .map(String::from)
}

#[tauri::command]
pub async fn fetch_session_phase() -> Result<SessionPhase, String> {
    Ok(SessionPhase {
        phase: current_loop_state().await.unwrap_or_default(),
    })
}

/// Watches the game phase and auto-shows the overlay at agent select.
pub fn spawn_phase_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Give the main window a moment to push the persisted auto-show setting.
        tokio::time::sleep(Duration::from_secs(2)).await;
        let mut last = String::new();
        loop {
            let phase = current_loop_state().await.unwrap_or_default();
            if phase != last {
                if phase == "PREGAME" {
                    MANUAL.store(false, Ordering::Relaxed);
                    if AUTO_SHOW.load(Ordering::Relaxed) {
                        AUTO_SHOWN.store(true, Ordering::Relaxed);
                        let _ = show(&app);
                    }
                } else if last == "PREGAME" {
                    if AUTO_SHOWN.swap(false, Ordering::Relaxed) && !MANUAL.load(Ordering::Relaxed) {
                        let _ = hide(&app);
                    }
                }
                last = phase;
            }
            // Keep the overlay above the game if the window manager reshuffles
            // the z-order when VALORANT takes focus.
            if let Some(window) = app.get_webview_window(OVERLAY_LABEL) {
                if window.is_visible().unwrap_or(false) {
                    let _ = window.set_always_on_top(true);
                }
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

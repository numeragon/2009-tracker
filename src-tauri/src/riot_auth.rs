//! Riot Sign-On (RSO) helper.
//!
//! The store check must work while VALORANT is closed, so the local Riot
//! Client lockfile is not enough. Instead we open Riot's own login page in a
//! child webview. When Riot redirects back to `playvalorant.com/opt_in` with an
//! `access_token` fragment we exchange it for the entitlement token and keep
//! the session. The user's password never touches this app, and federated
//! logins (Google/Apple) and 2FA work because they happen inside Riot's page.
//!
//! Subsequent logins reuse the webview's persistent cookies, so refreshing an
//! expired session is a redirect that closes on its own.

use reqwest::header::AUTHORIZATION;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

pub const RIOT_LOGIN_LABEL: &str = "riot-login";
const AUTH_URL: &str = "https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=1&scope=account%20openid";

/// Last successful login, kept in memory so a page that missed the event can
/// recover the session (tokens only; the password is never stored).
static LAST_SESSION: OnceLock<std::sync::Mutex<Option<RiotSession>>> = OnceLock::new();

fn last_session_cell() -> &'static std::sync::Mutex<Option<RiotSession>> {
    LAST_SESSION.get_or_init(|| std::sync::Mutex::new(None))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiotSession {
    pub puuid: String,
    pub game_name: String,
    pub tag_line: String,
    pub access_token: String,
    pub entitlements: String,
    /// Riot geo "live" affinity (ap / na / eu / kr / br / latam), may be empty.
    pub region: String,
    pub obtained_at: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RiotLoginResult {
    /// "ok" | "error"
    pub status: String,
    pub message: Option<String>,
    pub session: Option<RiotSession>,
}

/// Session data passed back from the frontend when fetching the store.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RiotSessionInput {
    pub access_token: String,
    pub entitlements: String,
    pub puuid: String,
    #[serde(default)]
    pub region: Option<String>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn error_result(message: impl Into<String>) -> RiotLoginResult {
    RiotLoginResult {
        status: "error".to_string(),
        message: Some(message.into()),
        session: None,
    }
}

fn extract_access_token(url: &tauri::Url) -> Option<String> {
    let host = url.host_str()?.to_lowercase();
    if host != "playvalorant.com" && host != "www.playvalorant.com" {
        return None;
    }
    if !url.path().contains("opt_in") {
        return None;
    }

    if let Some(fragment) = url.fragment() {
        for pair in fragment.split('&') {
            if let Some(token) = pair.strip_prefix("access_token=") {
                if !token.is_empty() {
                    return Some(token.to_string());
                }
            }
        }
    }
    for (key, value) in url.query_pairs() {
        if key == "access_token" && !value.is_empty() {
            return Some(value.into_owned());
        }
    }
    None
}

fn auth_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTPクライアント初期化エラー: {e}"))
}

async fn fetch_entitlements(client: &reqwest::Client, access_token: &str) -> Result<String, String> {
    let resp = client
        .post("https://entitlements.auth.riotgames.com/api/token/v1")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| format!("エンタイトルメント取得に失敗しました: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "エンタイトルメント取得に失敗しました (HTTP {})。",
            resp.status().as_u16()
        ));
    }

    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("エンタイトルメントの解析に失敗しました: {e}"))?;

    json.get("entitlements_token")
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| "エンタイトルメントトークンが返されませんでした。".to_string())
}

async fn fetch_userinfo(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<(String, String, String), String> {
    let resp = client
        .get("https://auth.riotgames.com/userinfo")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .send()
        .await
        .map_err(|e| format!("アカウント情報の取得に失敗しました: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!(
            "アカウント情報の取得に失敗しました (HTTP {})。",
            resp.status().as_u16()
        ));
    }

    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("アカウント情報の解析に失敗しました: {e}"))?;

    let puuid = json
        .get("sub")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let acct = json.get("acct");
    let game_name = acct
        .and_then(|a| a.get("game_name"))
        .or_else(|| acct.and_then(|a| a.get("gameName")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tag_line = acct
        .and_then(|a| a.get("tag_line"))
        .or_else(|| acct.and_then(|a| a.get("tagLine")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if puuid.is_empty() {
        return Err("PUUID を取得できませんでした。".to_string());
    }

    Ok((puuid, game_name, tag_line))
}

async fn fetch_region(client: &reqwest::Client, access_token: &str) -> Option<String> {
    let resp = client
        .put("https://riot-geo.pas.si.riotgames.com/pas/v1/product/valorant")
        .header(AUTHORIZATION, format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({}))
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let json: Value = resp.json().await.ok()?;
    json.get("affinities")
        .and_then(|a| a.get("live"))
        .and_then(|v| v.as_str())
        .map(|v| v.to_lowercase())
}

async fn finish_login(access_token: &str) -> RiotLoginResult {
    let client = match auth_client() {
        Ok(c) => c,
        Err(message) => return error_result(message),
    };

    let entitlements = match fetch_entitlements(&client, access_token).await {
        Ok(v) => v,
        Err(message) => return error_result(message),
    };

    let (puuid, game_name, tag_line) = match fetch_userinfo(&client, access_token).await {
        Ok(v) => v,
        Err(message) => return error_result(message),
    };

    let region = fetch_region(&client, access_token).await.unwrap_or_default();

    let session = RiotSession {
        puuid,
        game_name,
        tag_line,
        access_token: access_token.to_string(),
        entitlements,
        region,
        obtained_at: now_millis(),
    };

    if let Ok(mut guard) = last_session_cell().lock() {
        *guard = Some(session.clone());
    }

    RiotLoginResult {
        status: "ok".to_string(),
        message: None,
        session: Some(session),
    }
}

#[tauri::command]
pub async fn riot_login(app: AppHandle, fresh: Option<bool>) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(RIOT_LOGIN_LABEL) {
        let _ = existing.set_focus();
        return Ok(());
    }

    let url = AUTH_URL
        .parse::<tauri::Url>()
        .map_err(|e| format!("認証URLの生成に失敗しました: {e}"))?;

    let completed = Arc::new(AtomicBool::new(false));
    let completed_nav = completed.clone();
    let app_nav = app.clone();

    let mut builder =
        WebviewWindowBuilder::new(&app, RIOT_LOGIN_LABEL, WebviewUrl::External(url))
            .title("Riot ログイン")
            .inner_size(480.0, 780.0)
            .min_inner_size(380.0, 560.0)
            .center();
    // Adding another account must not reuse the previous account's cookies,
    // otherwise Riot would silently sign the same user back in.
    if fresh.unwrap_or(false) {
        builder = builder.incognito(true);
    }

    let window = builder
        .on_navigation(move |url| {
            if let Some(token) = extract_access_token(url) {
                if !completed_nav.swap(true, Ordering::SeqCst) {
                    let app = app_nav.clone();
                    tauri::async_runtime::spawn(async move {
                        let result = finish_login(&token).await;
                        if let Some(w) = app.get_webview_window(RIOT_LOGIN_LABEL) {
                            let _ = w.close();
                        }
                        let _ = app.emit("riot-auth-result", result);
                    });
                }
                // Never load the redirect page; we already have the token.
                return false;
            }
            true
        })
        .build()
        .map_err(|e| format!("ログインウィンドウを開けませんでした: {e}"))?;

    // Notify the UI if the user closes the window without finishing.
    let completed_evt = completed.clone();
    let app_evt = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if !completed_evt.swap(true, Ordering::SeqCst) {
                let _ = app_evt.emit(
                    "riot-auth-result",
                    error_result("ログインがキャンセルされました。"),
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn riot_last_session() -> Option<RiotSession> {
    last_session_cell()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

#[tauri::command]
pub fn riot_logout() {
    if let Ok(mut guard) = last_session_cell().lock() {
        *guard = None;
    }
}

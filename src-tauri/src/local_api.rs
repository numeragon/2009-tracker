use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::live_match::{
    CLIENT_PLATFORM_B64, fallback_glz_and_shard, read_lockfile, resolve_client_version,
    scan_shooter_game_log,
};
use crate::riot_auth::RiotSessionInput;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrosshairFetchResponse {
    pub ok: bool,
    pub message: Option<String>,
    /// Raw JSON string of `EAresStringSettingName::SavedCrosshairProfileData`.
    pub profile_data: Option<String>,
    /// Active profile name (when available).
    pub profile_name: Option<String>,
    /// Fallback primary color string from `CrosshairColor` (e.g. "(R=0,G=255,B=0,A=255)").
    pub crosshair_color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorefrontFetchResponse {
    pub ok: bool,
    pub message: Option<String>,
    pub puuid: Option<String>,
    pub shard: Option<String>,
    pub region: Option<String>,
    pub storefront: Option<Value>,
    pub wallet: Option<Value>,
    pub fetched_at: u64,
    /// "session" (Riot account login) or "client" (local Riot Client).
    pub auth_source: Option<String>,
    /// True when the saved Riot session expired and the user must log in again.
    pub auth_expired: bool,
}

struct RiotTokens {
    access_token: String,
    entitlement: String,
    subject: String,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn extract_json_string(data: &Value, key: &str) -> Option<String> {
    let list = data.get("stringSettings")?.as_array()?;
    for item in list {
        let name = item.get("settingEnum").and_then(|v| v.as_str()).unwrap_or("");
        if name == key {
            if let Some(v) = item.get("value").and_then(|v| v.as_str()) {
                return Some(v.to_string());
            }
        }
    }
    None
}

#[tauri::command]
pub async fn fetch_crosshair_settings() -> Result<CrosshairFetchResponse, String> {
    let Some(lock) = read_lockfile() else {
        return Ok(CrosshairFetchResponse {
            ok: false,
            message: Some(
                "VALORANT（Riot Client）が起動していません。ゲームを起動してから再取得してください。"
                    .to_string(),
            ),
            profile_data: None,
            profile_name: None,
            crosshair_color: None,
        });
    };

    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| format!("ローカルHTTPクライアント初期化エラー: {e}"))?;

    let basic = BASE64.encode(format!("riot:{}", lock.password));
    let url = format!(
        "https://127.0.0.1:{}/player-preferences/v1/data-json/Ares.PlayerSettings",
        lock.port
    );

    let resp = client
        .get(&url)
        .header(AUTHORIZATION, format!("Basic {basic}"))
        .send()
        .await
        .map_err(|e| format!("Riot Client への接続に失敗しました: {e}"))?;

    if !resp.status().is_success() {
        return Ok(CrosshairFetchResponse {
            ok: false,
            message: Some(format!(
                "プレイヤー設定の取得に失敗しました (HTTP {})。ゲームにログインしているか確認してください。",
                resp.status().as_u16()
            )),
            profile_data: None,
            profile_name: None,
            crosshair_color: None,
        });
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("プレイヤー設定の解析に失敗しました: {e}"))?;

    // Response is usually { "data": { ... } }, but some client versions return the object directly.
    let data = body.get("data").unwrap_or(&body);

    let profile_data =
        extract_json_string(data, "EAresStringSettingName::SavedCrosshairProfileData");
    let profile_name = extract_json_string(data, "EAresStringSettingName::CrosshairProfileName");
    let crosshair_color = extract_json_string(data, "EAresStringSettingName::CrosshairColor");

    let has_any = profile_data.is_some() || crosshair_color.is_some();
    Ok(CrosshairFetchResponse {
        ok: has_any,
        message: if has_any {
            None
        } else {
            Some(
                "クロスヘア設定が見つかりませんでした。ゲーム内でクロスヘアを一度保存してください。"
                    .to_string(),
            )
        },
        profile_data,
        profile_name,
        crosshair_color,
    })
}

async fn fetch_riot_tokens(
    client: &reqwest::Client,
    port: &str,
    password: &str,
) -> Result<RiotTokens, String> {
    let basic = BASE64.encode(format!("riot:{password}"));
    let url = format!("https://127.0.0.1:{port}/entitlements/v1/token");
    let resp = client
        .get(&url)
        .header(AUTHORIZATION, format!("Basic {basic}"))
        .send()
        .await
        .map_err(|e| format!("Riot Client への接続に失敗しました: {e}"))?;

    if !resp.status().is_success() {
        return Err("Riot Client にログインしていません。VALORANT を起動してください。".to_string());
    }

    let json: Value = resp
        .json()
        .await
        .map_err(|e| format!("認証トークンの解析に失敗しました: {e}"))?;

    let access_token = json
        .get("accessToken")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "アクセストークンが取得できませんでした。".to_string())?
        .to_string();
    let entitlement = json
        .get("token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "エンタイトルメントトークンが取得できませんでした。".to_string())?
        .to_string();
    let subject = json
        .get("subject")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Ok(RiotTokens {
        access_token,
        entitlement,
        subject,
    })
}

fn storefront_error(
    message: impl Into<String>,
    puuid: Option<String>,
    shard: Option<String>,
    region: Option<String>,
    auth_source: Option<&str>,
    auth_expired: bool,
) -> StorefrontFetchResponse {
    StorefrontFetchResponse {
        ok: false,
        message: Some(message.into()),
        puuid,
        shard,
        region,
        storefront: None,
        wallet: None,
        fetched_at: now_millis(),
        auth_source: auth_source.map(String::from),
        auth_expired,
    }
}

#[tauri::command]
pub async fn fetch_storefront(
    region_fallback: String,
    session: Option<RiotSessionInput>,
) -> Result<StorefrontFetchResponse, String> {
    let remote_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("HTTPクライアント初期化エラー: {e}"))?;

    // A Riot account session lets the store work with the game closed. When no
    // session is available we keep the old local-client fallback.
    let session = session.filter(|s| !s.access_token.is_empty() && !s.puuid.is_empty());

    let (access_token, entitlement, puuid, region_hint, log_info, auth_source) =
        if let Some(s) = session {
            let hint = s
                .region
                .clone()
                .filter(|r| !r.trim().is_empty())
                .unwrap_or_else(|| region_fallback.clone());
            (s.access_token, s.entitlements, s.puuid, hint, None, "session")
        } else {
            let Some(lock) = read_lockfile() else {
                return Ok(storefront_error(
                    "Riotアカウントにログインすると、ゲームを起動していなくてもストアを確認できます。",
                    None,
                    None,
                    None,
                    None,
                    false,
                ));
            };

            let local_client = reqwest::Client::builder()
                .danger_accept_invalid_certs(true)
                .timeout(Duration::from_secs(6))
                .build()
                .map_err(|e| format!("ローカルHTTPクライアント初期化エラー: {e}"))?;

            let tokens =
                match fetch_riot_tokens(&local_client, &lock.port, &lock.password).await {
                    Ok(t) => t,
                    Err(message) => {
                        return Ok(storefront_error(
                            message, None, None, None, None, false,
                        ));
                    }
                };

            (
                tokens.access_token,
                tokens.entitlement,
                tokens.subject,
                region_fallback.clone(),
                Some(scan_shooter_game_log()),
                "client",
            )
        };

    let (fb_glz, fb_shard) = fallback_glz_and_shard(&region_hint);
    let glz_region = log_info
        .as_ref()
        .and_then(|l| l.glz_region.clone())
        .unwrap_or(fb_glz);
    let shard = log_info
        .as_ref()
        .and_then(|l| l.shard.clone())
        .unwrap_or(fb_shard);
    let client_version =
        resolve_client_version(&remote_client, log_info.and_then(|l| l.client_version)).await;

    if puuid.is_empty() {
        return Ok(storefront_error(
            "プレイヤー情報（PUUID）を取得できませんでした。",
            None,
            Some(shard),
            Some(glz_region),
            Some(auth_source),
            auth_source == "session",
        ));
    }

    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {access_token}")) {
        headers.insert(AUTHORIZATION, v);
    }
    if let Ok(v) = HeaderValue::from_str(&entitlement) {
        headers.insert("X-Riot-Entitlements-JWT", v);
    }
    if let Ok(v) = HeaderValue::from_str(&client_version) {
        headers.insert("X-Riot-ClientVersion", v);
    }
    headers.insert(
        "X-Riot-ClientPlatform",
        HeaderValue::from_static(CLIENT_PLATFORM_B64),
    );

    let store_url = format!("https://pd.{shard}.a.pvp.net/store/v2/storefront/{puuid}");
    let storefront = match remote_client
        .get(&store_url)
        .headers(headers.clone())
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
        Ok(r) => {
            let expired =
                auth_source == "session" && r.status() == reqwest::StatusCode::UNAUTHORIZED;
            let message = if expired {
                "Riotセッションの有効期限が切れました。再ログインしてください。".to_string()
            } else {
                format!(
                    "ストア情報の取得に失敗しました (HTTP {})。",
                    r.status().as_u16()
                )
            };
            return Ok(storefront_error(
                message,
                Some(puuid),
                Some(shard),
                Some(glz_region),
                Some(auth_source),
                expired,
            ));
        }
        Err(e) => {
            return Ok(storefront_error(
                format!("ストア情報の取得に失敗しました: {e}"),
                Some(puuid),
                Some(shard),
                Some(glz_region),
                Some(auth_source),
                false,
            ));
        }
    };

    let wallet_url = format!("https://pd.{shard}.a.pvp.net/store/v1/wallet/{puuid}");
    let wallet = match remote_client
        .get(&wallet_url)
        .headers(headers.clone())
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
        _ => None,
    };

    Ok(StorefrontFetchResponse {
        ok: storefront.is_some(),
        message: if storefront.is_some() {
            None
        } else {
            Some("ストア情報を取得できませんでした。".to_string())
        },
        puuid: Some(puuid),
        shard: Some(shard),
        region: Some(glz_region),
        storefront,
        wallet,
        fetched_at: now_millis(),
        auth_source: Some(auth_source.to_string()),
        auth_expired: false,
    })
}

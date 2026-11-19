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

#[tauri::command]
pub async fn fetch_storefront(region_fallback: String) -> Result<StorefrontFetchResponse, String> {
    let Some(lock) = read_lockfile() else {
        return Ok(StorefrontFetchResponse {
            ok: false,
            message: Some(
                "VALORANT（Riot Client）が起動していません。ゲームを起動してから再取得してください。"
                    .to_string(),
            ),
            puuid: None,
            shard: None,
            region: None,
            storefront: None,
            wallet: None,
            fetched_at: now_millis(),
        });
    };

    let local_client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| format!("ローカルHTTPクライアント初期化エラー: {e}"))?;
    let remote_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("HTTPクライアント初期化エラー: {e}"))?;

    let tokens = match fetch_riot_tokens(&local_client, &lock.port, &lock.password).await {
        Ok(t) => t,
        Err(message) => {
            return Ok(StorefrontFetchResponse {
                ok: false,
                message: Some(message),
                puuid: None,
                shard: None,
                region: None,
                storefront: None,
                wallet: None,
                fetched_at: now_millis(),
            });
        }
    };

    let log_info = scan_shooter_game_log();
    let (fb_glz, fb_shard) = fallback_glz_and_shard(&region_fallback);
    let glz_region = log_info.glz_region.clone().unwrap_or(fb_glz);
    let shard = log_info.shard.clone().unwrap_or(fb_shard);
    let client_version = resolve_client_version(&remote_client, log_info.client_version).await;

    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", tokens.access_token)) {
        headers.insert(AUTHORIZATION, v);
    }
    if let Ok(v) = HeaderValue::from_str(&tokens.entitlement) {
        headers.insert("X-Riot-Entitlements-JWT", v);
    }
    if let Ok(v) = HeaderValue::from_str(&client_version) {
        headers.insert("X-Riot-ClientVersion", v);
    }
    headers.insert(
        "X-Riot-ClientPlatform",
        HeaderValue::from_static(CLIENT_PLATFORM_B64),
    );

    let puuid = tokens.subject.clone();
    if puuid.is_empty() {
        return Ok(StorefrontFetchResponse {
            ok: false,
            message: Some("プレイヤー情報（PUUID）を取得できませんでした。".to_string()),
            puuid: None,
            shard: Some(shard),
            region: Some(glz_region),
            storefront: None,
            wallet: None,
            fetched_at: now_millis(),
        });
    }

    let store_url = format!(
        "https://pd.{shard}.a.pvp.net/store/v2/storefront/{puuid}"
    );
    let store_resp = remote_client
        .get(&store_url)
        .headers(headers.clone())
        .send()
        .await;

    let storefront = match store_resp {
        Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
        Ok(r) => {
            return Ok(StorefrontFetchResponse {
                ok: false,
                message: Some(format!(
                    "ストア情報の取得に失敗しました (HTTP {})。",
                    r.status().as_u16()
                )),
                puuid: Some(puuid),
                shard: Some(shard),
                region: Some(glz_region),
                storefront: None,
                wallet: None,
                fetched_at: now_millis(),
            });
        }
        Err(e) => {
            return Ok(StorefrontFetchResponse {
                ok: false,
                message: Some(format!("ストア情報の取得に失敗しました: {e}")),
                puuid: Some(puuid),
                shard: Some(shard),
                region: Some(glz_region),
                storefront: None,
                wallet: None,
                fetched_at: now_millis(),
            });
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
    })
}

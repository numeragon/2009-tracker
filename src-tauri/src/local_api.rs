use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::Serialize;
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::live_match::{
    CLIENT_PLATFORM_B64, LockfileInfo, fallback_glz_and_shard, read_lockfile,
    resolve_client_version, scan_shooter_game_log,
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

/// Routes the Riot Client may expose for player preferences. Newer clients only
/// expose the product-scoped route, which is why the bare `Ares.PlayerSettings`
/// path can answer with HTTP 500 even while the client is running.
const PREFERENCE_ROUTES: [&str; 3] = [
    "/player-preferences/v1/data-json/productId/valorant/type/Ares.PlayerSettings",
    "/player-preferences/v1/data-json/Ares.PlayerSettings",
    "/player-preferences/v1/data/Ares.PlayerSettings",
];

fn decode_base64_any(raw: &str) -> Option<Vec<u8>> {
    BASE64.decode(raw).ok().or_else(|| {
        base64::engine::general_purpose::STANDARD_NO_PAD
            .decode(raw)
            .ok()
    })
}

fn inflate_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    use std::io::Read as _;

    let mut out = Vec::new();
    if flate2::read::DeflateDecoder::new(bytes)
        .read_to_end(&mut out)
        .is_ok()
        && !out.is_empty()
    {
        return Some(out);
    }

    out.clear();
    if flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .is_ok()
        && !out.is_empty()
    {
        return Some(out);
    }

    None
}

/// The remote player-preferences service wraps the settings in
/// `{ "type", "data", "modified" }`. Depending on the route the `data` field is
/// either the settings object, a JSON string, or a base64/deflate blob.
fn decode_preference_payload(value: &Value) -> Option<Value> {
    let data = value.get("data").unwrap_or(value);
    match data {
        Value::Object(_) => Some(data.clone()),
        Value::String(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            if trimmed.starts_with('{') {
                if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
                    return Some(parsed);
                }
            }
            let bytes = decode_base64_any(trimmed)?;
            let inflated = inflate_bytes(&bytes)?;
            serde_json::from_slice::<Value>(&inflated).ok()
        }
        _ => None,
    }
}

/// The preferences plugin answers 500 for a short time while it is still
/// starting (e.g. right after the Riot Client launches), so wait briefly for
/// it to report ready before giving up.
async fn wait_for_preferences_ready(client: &reqwest::Client, port: &str, basic: &str) {
    let url = format!("https://127.0.0.1:{port}/player-preferences/v1/ready");
    for attempt in 0..6 {
        match client
            .get(&url)
            .header(AUTHORIZATION, format!("Basic {basic}"))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                let ready = resp
                    .text()
                    .await
                    .map(|body| body.trim().eq_ignore_ascii_case("true"))
                    .unwrap_or(false);
                if ready {
                    return;
                }
            }
            // Older clients do not expose the readiness route at all.
            Ok(resp) if resp.status().as_u16() == 404 => return,
            _ => {}
        }
        if attempt < 5 {
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    }
}

async fn fetch_preference_local(
    client: &reqwest::Client,
    lock: &LockfileInfo,
) -> Result<Value, String> {
    let basic = BASE64.encode(format!("riot:{}", lock.password));
    wait_for_preferences_ready(client, &lock.port, &basic).await;

    let mut last_error = String::from("プレイヤー設定を取得できませんでした。");
    for route in PREFERENCE_ROUTES {
        let url = format!("https://127.0.0.1:{}{route}", lock.port);
        let resp = match client
            .get(&url)
            .header(AUTHORIZATION, format!("Basic {basic}"))
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                last_error = e.to_string();
                continue;
            }
        };

        if !resp.status().is_success() {
            last_error = format!("HTTP {}", resp.status().as_u16());
            continue;
        }

        match resp.json::<Value>().await {
            Ok(body) => match decode_preference_payload(&body) {
                Some(settings) => return Ok(settings),
                None => last_error = "設定データを解析できませんでした。".to_string(),
            },
            Err(e) => last_error = format!("設定データの解析に失敗しました: {e}"),
        }
    }

    Err(last_error)
}

fn preference_hosts(region: &str) -> Vec<&'static str> {
    match region.to_ascii_lowercase().as_str() {
        "eu" => vec!["euc1", "usw2"],
        "na" | "latam" | "br" => vec!["usw2", "euc1"],
        "kr" => vec!["apne1", "apse1"],
        "ap" => vec!["apne1", "apse1"],
        _ => vec!["usw2", "euc1", "apne1", "apse1"],
    }
}

/// Cloud copy of the same settings document. This is used when the local
/// plugin fails (or when an account session is available and the game is
/// closed), and it is what makes crosshair fetching reliable.
async fn fetch_preference_remote(
    client: &reqwest::Client,
    access_token: &str,
    entitlement: &str,
    client_version: &str,
    region: &str,
) -> Result<Value, String> {
    let mut last_error = String::from("プレイヤー設定を取得できませんでした。");
    for host in preference_hosts(region) {
        let url = format!(
            "https://player-preferences-{host}.pp.sgp.pvp.net/playerPref/v3/getPreference/Ares.PlayerSettings"
        );
        let mut request = client
            .get(&url)
            .header(AUTHORIZATION, format!("Bearer {access_token}"))
            .header("X-Riot-ClientPlatform", CLIENT_PLATFORM_B64);
        if !entitlement.is_empty() {
            request = request.header("X-Riot-Entitlements-JWT", entitlement);
        }
        if !client_version.is_empty() {
            request = request.header("X-Riot-ClientVersion", client_version);
        }

        let resp = match request.send().await {
            Ok(resp) => resp,
            Err(e) => {
                last_error = e.to_string();
                continue;
            }
        };

        if !resp.status().is_success() {
            last_error = format!("HTTP {}", resp.status().as_u16());
            continue;
        }

        match resp.json::<Value>().await {
            Ok(body) => match decode_preference_payload(&body) {
                Some(settings) => return Ok(settings),
                None => last_error = "設定データを解析できませんでした。".to_string(),
            },
            Err(e) => last_error = format!("設定データの解析に失敗しました: {e}"),
        }
    }

    Err(last_error)
}

fn crosshair_response(settings: &Value) -> CrosshairFetchResponse {
    let profile_data =
        extract_json_string(settings, "EAresStringSettingName::SavedCrosshairProfileData");
    let profile_name = extract_json_string(settings, "EAresStringSettingName::CrosshairProfileName");
    let crosshair_color = extract_json_string(settings, "EAresStringSettingName::CrosshairColor");

    let has_any = profile_data.is_some() || crosshair_color.is_some();
    CrosshairFetchResponse {
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
    }
}

#[tauri::command]
pub async fn fetch_crosshair_settings(
    region_fallback: Option<String>,
    session: Option<RiotSessionInput>,
) -> Result<CrosshairFetchResponse, String> {
    let remote_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("HTTPクライアント初期化エラー: {e}"))?;
    let local_client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| format!("ローカルHTTPクライアント初期化エラー: {e}"))?;

    let session = session.filter(|s| !s.access_token.is_empty());
    let lock = read_lockfile();
    let log_info = scan_shooter_game_log();

    let region_hint = session
        .as_ref()
        .and_then(|s| s.region.clone())
        .filter(|r| !r.trim().is_empty())
        .or(log_info.glz_region.clone())
        .or(region_fallback)
        .unwrap_or_else(|| "na".to_string());

    // 1) Local Riot Client (works while the game is running). Try every route
    //    the client may expose instead of only the legacy one.
    let mut local_error: Option<String> = None;
    if let Some(lock) = lock.as_ref() {
        match fetch_preference_local(&local_client, lock).await {
            Ok(settings) => return Ok(crosshair_response(&settings)),
            Err(err) => local_error = Some(err),
        }
    }

    // 2) Cloud player-preferences. Prefer the stored Riot account session so
    //    this also works with the game closed, then fall back to the local
    //    client's tokens.
    let mut tokens: Option<(String, String)> = session
        .as_ref()
        .map(|s| (s.access_token.clone(), s.entitlements.clone()));
    if tokens.is_none() {
        if let Some(lock) = lock.as_ref() {
            if let Ok(local_tokens) =
                fetch_riot_tokens(&local_client, &lock.port, &lock.password).await
            {
                tokens = Some((local_tokens.access_token, local_tokens.entitlement));
            }
        }
    }

    let Some((access_token, entitlement)) = tokens else {
        let message = if lock.is_none() && session.is_none() {
            "VALORANT（Riot Client）が起動していません。ゲームを起動するか、ショップ画面からRiotアカウントにログインすると取得できます。"
                .to_string()
        } else {
            "Riot Client にログインしていません。VALORANT を起動してから再取得してください。"
                .to_string()
        };
        return Ok(CrosshairFetchResponse {
            ok: false,
            message: Some(message),
            profile_data: None,
            profile_name: None,
            crosshair_color: None,
        });
    };

    let client_version =
        resolve_client_version(&remote_client, log_info.client_version).await;

    match fetch_preference_remote(
        &remote_client,
        &access_token,
        &entitlement,
        &client_version,
        &region_hint,
    )
    .await
    {
        Ok(settings) => Ok(crosshair_response(&settings)),
        Err(remote_error) => {
            let detail = local_error
                .filter(|local| !local.is_empty())
                .map(|local| format!("クライアント: {local} / クラウド: {remote_error}"))
                .unwrap_or(remote_error);
            Ok(CrosshairFetchResponse {
                ok: false,
                message: Some(format!(
                    "クロスヘア設定を取得できませんでした。ゲーム内で一度クロスヘアを保存してから再取得してください。（{detail}）"
                )),
                profile_data: None,
                profile_name: None,
                crosshair_color: None,
            })
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::DeflateEncoder;
    use std::io::Write as _;

    #[test]
    fn decodes_object_payload() {
        let body = serde_json::json!({
            "type": "Ares.PlayerSettings",
            "data": { "a": 1 },
            "modified": 0
        });
        let decoded = decode_preference_payload(&body).expect("object payload");
        assert_eq!(decoded["a"], 1);
    }

    #[test]
    fn decodes_json_string_payload() {
        let body = serde_json::json!({ "data": "{\"b\":2}" });
        let decoded = decode_preference_payload(&body).expect("string payload");
        assert_eq!(decoded["b"], 2);
    }

    #[test]
    fn decodes_base64_deflate_payload() {
        let raw = br#"{"c":3}"#;
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(raw).unwrap();
        let compressed = encoder.finish().unwrap();
        let body = serde_json::json!({ "data": BASE64.encode(compressed) });
        let decoded = decode_preference_payload(&body).expect("compressed payload");
        assert_eq!(decoded["c"], 3);
    }

    #[test]
    fn rejects_empty_payload() {
        assert!(decode_preference_payload(&serde_json::json!({ "data": "" })).is_none());
    }
}

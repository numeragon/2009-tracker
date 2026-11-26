//! Riot Mobile 2FA helper.
//!
//! Port of the account part of `Askin242/RiotGames-Mobile-2FA-Bypass`:
//! log in on account.riotgames.com, enable the `riotmobile` factor, and return
//! the TOTP seed. The tracker only uses the seed to show 6-digit codes; the
//! seed never leaves the machine.

use hmac::{Hmac, Mac};
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::Serialize;
use serde_json::{Value, json};
use sha2::Sha256;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LOGIN_LABEL: &str = "riot-2fa-login";
const ACCOUNT_HOST: &str = "account.riotgames.com";
const AUTH_HOST: &str = "auth.riotgames.com";
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Riot2faLoginResult {
    pub ok: bool,
    pub message: Option<String>,
    pub warning: Option<String>,
    pub name: Option<String>,
    pub puuid: Option<String>,
    pub secret: Option<String>,
}

fn error(message: impl Into<String>) -> Riot2faLoginResult {
    Riot2faLoginResult {
        ok: false,
        message: Some(message.into()),
        warning: None,
        name: None,
        puuid: None,
        secret: None,
    }
}

fn api_headers(cookie: &str, csrf: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(cookie) {
        headers.insert("Cookie", value);
    }
    if let Ok(value) = HeaderValue::from_str(csrf) {
        headers.insert("csrf-token", value);
    }
    headers.insert("accept", HeaderValue::from_static("application/json"));
    headers.insert(
        "content-type",
        HeaderValue::from_static("application/json"),
    );
    headers.insert("origin", HeaderValue::from_static("https://account.riotgames.com"));
    headers.insert(
        "referer",
        HeaderValue::from_static("https://account.riotgames.com/"),
    );
    headers.insert("user-agent", HeaderValue::from_static(USER_AGENT));
    headers
}

fn domain_matches(cookie_domain: &str, host: &str) -> bool {
    let domain = cookie_domain.trim_start_matches('.').to_lowercase();
    !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
}

fn cookie_header_for(cookies: &[(String, String, String)], host: &str) -> String {
    cookies
        .iter()
        .filter(|(_, domain, _)| domain_matches(domain, host))
        .map(|(name, _, value)| format!("{name}={value}"))
        .collect::<Vec<_>>()
        .join("; ")
}

fn find_cookie<'a>(
    cookies: &'a [(String, String, String)],
    host: &str,
    name: &str,
) -> Option<&'a str> {
    cookies
        .iter()
        .filter(|(cookie_name, domain, _)| cookie_name == name && domain_matches(domain, host))
        .map(|(_, _, value)| value.as_str())
        .next()
}

fn base32_decode(input: &str) -> Option<Vec<u8>> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let clean: String = input
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase();
    let mut bits = 0u32;
    let mut value = 0u32;
    let mut out = Vec::new();
    for ch in clean.bytes() {
        let index = ALPHABET.iter().position(|&b| b == ch)? as u32;
        value = (value << 5) | index;
        bits += 5;
        if bits >= 8 {
            out.push((value >> (bits - 8)) as u8);
            bits -= 8;
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

/// Riot's TOTP is HMAC-SHA256 (not SHA1), 30 s period, 6 digits.
fn totp_sha256_at(secret: &str, counter: u64) -> Option<String> {
    let key = base32_decode(secret)?;
    let mut mac = Hmac::<Sha256>::new_from_slice(&key).ok()?;
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let code = (((digest[offset] & 0x7f) as u32) << 24
        | ((digest[offset + 1] as u32) << 16)
        | ((digest[offset + 2] as u32) << 8)
        | (digest[offset + 3] as u32))
        % 1_000_000;
    Some(format!("{code:06}"))
}

fn totp_sha256(secret: &str) -> Option<String> {
    let counter = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs()
        / 30;
    totp_sha256_at(secret, counter)
}

fn extract_csrf(html: &str) -> Option<String> {
    let marker = "<meta name='csrf-token' content='";
    let start = html.find(marker)? + marker.len();
    let rest = &html[start..];
    let end = rest.find('\'')?;
    Some(rest[..end].to_string())
}

#[tauri::command]
pub async fn riot_2fa_login(app: AppHandle) -> Result<Riot2faLoginResult, String> {
    if let Some(existing) = app.get_webview_window(LOGIN_LABEL) {
        let _ = existing.close();
    }

    let url = "https://account.riotgames.com/"
        .parse::<tauri::Url>()
        .map_err(|e| format!("認証URLの生成に失敗しました: {e}"))?;

    let window = WebviewWindowBuilder::new(&app, LOGIN_LABEL, WebviewUrl::External(url))
        .title("Riot 2FA ログイン")
        .inner_size(520.0, 800.0)
        .min_inner_size(420.0, 620.0)
        .incognito(true)
        .center()
        .build()
        .map_err(|e| format!("ログイン画面を開けませんでした: {e}"))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| format!("HTTPクライアント初期化エラー: {e}"))?;

    // Poll until the account API actually accepts the session. Waiting for the
    // `ssid` and `a12l-csrf-prod` cookies alone is not enough: the CSRF cookie
    // already exists on the signed-out login page.
    let deadline = std::time::Instant::now() + Duration::from_secs(600);
    let mut attempts: u32 = 0;

    let (csrf, account_cookie, user, cookies) = loop {
        if app.get_webview_window(LOGIN_LABEL).is_none() {
            return Ok(error("ログイン画面が閉じられました。"));
        }
        if std::time::Instant::now() > deadline {
            let _ = window.close();
            return Ok(error("ログインがタイムアウトしました。"));
        }

        let cookies: Vec<(String, String, String)> = window
            .cookies()
            .map(|list| {
                list.iter()
                    .map(|cookie| {
                        (
                            cookie.name().to_string(),
                            cookie.domain().unwrap_or("").to_string(),
                            cookie.value().to_string(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();

        let logged_in = find_cookie(&cookies, AUTH_HOST, "ssid").is_some_and(|v| !v.is_empty());
        let candidate_cookie = cookie_header_for(&cookies, ACCOUNT_HOST);
        let candidate_csrf = find_cookie(&cookies, ACCOUNT_HOST, "a12l-csrf-prod")
            .unwrap_or("")
            .to_string();
        if logged_in && !candidate_cookie.is_empty() && !candidate_csrf.is_empty() {
            attempts += 1;
            let mut try_csrf = candidate_csrf;
            // Riot rotates the CSRF cookie; refresh it from the page HTML now
            // and then in case the API keeps rejecting it.
            if attempts == 1 || attempts % 5 == 0 {
                if let Ok(resp) = client
                    .get("https://account.riotgames.com/")
                    .header("Cookie", candidate_cookie.clone())
                    .header("user-agent", USER_AGENT)
                    .send()
                    .await
                {
                    if let Ok(html) = resp.text().await {
                        if let Some(fresh) = extract_csrf(&html) {
                            try_csrf = fresh;
                        }
                    }
                }
            }
            if let Ok(resp) = client
                .get(format!("https://{ACCOUNT_HOST}/api/account/v1/user"))
                .headers(api_headers(&candidate_cookie, &try_csrf))
                .send()
                .await
            {
                if resp.status().is_success() {
                    if let Some(body) = resp.json::<Value>().await.ok() {
                        break (try_csrf, candidate_cookie, body, cookies);
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
    };
    let _ = window.close();

    let name = {
        let game = user
            .pointer("/alias/game_name")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let tag = user
            .pointer("/alias/tag_line")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if game.is_empty() {
            user.get("username")
                .and_then(|v| v.as_str())
                .unwrap_or("Riotアカウント")
                .to_string()
        } else if tag.is_empty() {
            game.to_string()
        } else {
            format!("{game}#{tag}")
        }
    };
    let puuid = user
        .get("puuid")
        .or_else(|| user.get("sub"))
        .and_then(|v| v.as_str())
        .map(String::from);

    // Email 2FA is a prerequisite for the riotmobile factor.
    let factors = match client
        .get(format!("https://{ACCOUNT_HOST}/api/mfa/v2/factors"))
        .headers(api_headers(&account_cookie, &csrf))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp.json::<Value>().await.ok(),
        _ => None,
    };
    if let Some(factors) = factors.as_ref() {
        let list = factors
            .as_array()
            .cloned()
            .or_else(|| factors.get("factors").and_then(|v| v.as_array()).cloned())
            .unwrap_or_default();
        let email_enabled = list.iter().any(|factor| {
            factor.get("factor").and_then(|v| v.as_str()) == Some("email")
                && factor.get("status").and_then(|v| v.as_str()) == Some("enabled")
        });
        if !email_enabled {
            return Ok(error(
                "メール認証（2FA）が有効になっていません。Riotアカウントのセキュリティ設定でメール2FAを有効にしてから再試行してください。",
            ));
        }
    }

    let secret = match client
        .post(format!(
            "https://{ACCOUNT_HOST}/api/mfa/v2/factors/riotmobile/enable"
        ))
        .headers(api_headers(&account_cookie, &csrf))
        .json(&json!({}))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => resp.json::<Value>().await.ok(),
        _ => None,
    }
    .and_then(|body| {
        body.get("secret")
            .and_then(|v| v.as_str())
            .map(String::from)
    });

    let Some(secret) = secret.filter(|secret| !secret.is_empty()) else {
        return Ok(error(
            "Riot Mobile 2FAのシークレットを取得できませんでした。すでに有効になっている場合は、Riot側で無効化してから再試行してください。",
        ));
    };

    // Mint a fresh access token from the SSO cookies so Riot can verify the
    // first generated code. Failure here is non-fatal: the seed is still valid.
    let mut warning: Option<String> = None;
    let auth_cookie = cookie_header_for(&cookies, AUTH_HOST);
    if !auth_cookie.is_empty() {
        if let Ok(resp) = client
            .post("https://auth.riotgames.com/api/v1/authorization")
            .header("Cookie", auth_cookie)
            .header("Content-Type", "application/json")
            .header("user-agent", USER_AGENT)
            .json(&json!({
                "client_id": "ritoplus",
                "nonce": "1",
                "redirect_uri": "http://localhost/redirect",
                "response_type": "token id_token",
                "scope": "openid account link ban lol summoner offline_access riot://riot.authenticator/session.auth"
            }))
            .send()
            .await
        {
            if let Ok(body) = resp.json::<Value>().await {
                if let Some(uri) = body
                    .pointer("/response/parameters/uri")
                    .and_then(|v| v.as_str())
                {
                    if let Some(token) = uri
                        .split("access_token=")
                        .nth(1)
                        .and_then(|rest| rest.split('&').next())
                    {
                        if let Some(otp) = totp_sha256(&secret) {
                            match client
                                .post("https://api.account.riotgames.com/mfa/v1/factor/riotmobile/verify")
                                .header(AUTHORIZATION, format!("Bearer {token}"))
                                .header("Content-Type", "application/json")
                                .json(&json!({ "device": "Windows PC", "otp": otp }))
                                .send()
                                .await
                            {
                                Ok(resp) if resp.status().is_success() => {}
                                Ok(resp) => {
                                    warning = Some(format!(
                                        "2FAは有効化されましたが、初回コードの確認に失敗しました（HTTP {}）。シークレットは保存されています。",
                                        resp.status().as_u16()
                                    ));
                                }
                                Err(err) => {
                                    warning = Some(format!(
                                        "2FAは有効化されましたが、初回コードの確認に失敗しました（{err}）。シークレットは保存されています。"
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(Riot2faLoginResult {
        ok: true,
        message: None,
        warning,
        name: Some(name),
        puuid,
        secret: Some(secret),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Riot2faImportedAccount {
    pub name: String,
    pub seed: String,
}

/// Imports the accounts saved by `Askin242/RiotGames-Mobile-2FA-Bypass`
/// (`%APPDATA%\Riot2FA\accounts.json`) so users can keep their existing seeds.
#[tauri::command]
pub fn read_riot2fa_accounts() -> Result<Vec<Riot2faImportedAccount>, String> {
    let appdata = std::env::var_os("APPDATA").ok_or("APPDATA が見つかりません。")?;
    let path = PathBuf::from(appdata)
        .join("Riot2FA")
        .join("accounts.json");
    let raw = std::fs::read_to_string(&path)
        .map_err(|_| "Riot2FA のアカウントファイルが見つかりません。".to_string())?;
    let json: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("Riot2FA の accounts.json を解析できませんでした: {e}"))?;
    let mut out = Vec::new();
    if let Some(list) = json.as_array() {
        for item in list {
            let name = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("Riotアカウント");
            let seed = item.get("seed").and_then(|v| v.as_str()).unwrap_or("");
            if !seed.trim().is_empty() {
                out.push(Riot2faImportedAccount {
                    name: name.to_string(),
                    seed: seed.trim().to_string(),
                });
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_decodes_rfc4648_vector() {
        assert_eq!(base32_decode("MZXW6===").unwrap(), b"foo");
        assert_eq!(base32_decode("MZXW6YTB").unwrap(), b"fooba");
        assert!(base32_decode("0189").is_none());
    }

    /// RFC 6238 appendix B, SHA-256 rows, truncated to the 6 digits Riot uses.
    #[test]
    fn totp_matches_rfc6238_sha256_vectors() {
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA";
        let vectors = [
            (1u64, "119246"),
            (37_037_036, "084774"),
            (37_037_037, "062674"),
            (41_152_263, "819424"),
            (66_666_666, "698825"),
            (666_666_666, "737706"),
        ];
        for (counter, expected) in vectors {
            assert_eq!(
                totp_sha256_at(secret, counter).as_deref(),
                Some(expected),
                "counter {counter}"
            );
        }
    }

    #[test]
    fn totp_rejects_invalid_secret() {
        assert!(totp_sha256_at("", 1).is_none());
        assert!(totp_sha256_at("0189", 1).is_none());
    }

    #[test]
    fn csrf_is_read_from_account_page_markup() {
        let html = "<head><meta name='csrf-token' content='abc123'></head>";
        assert_eq!(extract_csrf(html).as_deref(), Some("abc123"));
        assert!(extract_csrf("<html></html>").is_none());
    }
}

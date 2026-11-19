use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::fs::OpenOptionsExt;

pub(crate) const CLIENT_PLATFORM_B64: &str = "ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuMjU2LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9";

static CACHED_CLIENT_VERSION: OnceLock<tokio::sync::Mutex<Option<String>>> = OnceLock::new();

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMatchPlayerRaw {
    pub puuid: String,
    pub game_name: String,
    pub tag_line: String,
    pub team_id: String,
    pub is_ally: bool,
    pub is_self: bool,
    pub agent_id: String,
    pub selection_state: String,
    pub account_level: i64,
    pub hide_account_level: bool,
    pub is_incognito: bool,
    pub card_id: String,
    pub pregame_tier: i64,
    /// Party lobby only: ready check state / party owner.
    pub party_ready: Option<bool>,
    pub is_party_owner: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveMatchResponse {
    /// "NOT_RUNNING" | "IN_MENU" | "PREGAME" | "IN_GAME" | "ERROR"
    pub status: String,
    pub message: Option<String>,
    pub match_id: Option<String>,
    pub map_url: Option<String>,
    pub mode_id: Option<String>,
    pub queue_id: Option<String>,
    pub server_pod: Option<String>,
    pub detected_region: Option<String>,
    pub detected_shard: Option<String>,
    pub self_puuid: Option<String>,
    /// "attack" | "defense" (agent select only; None when unknown)
    pub ally_side: Option<String>,
    pub players: Vec<LiveMatchPlayerRaw>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntitlementsTokenResp {
    access_token: String,
    subject: String,
    token: String,
}

#[derive(Debug, Deserialize)]
struct PlayerMatchResp {
    #[serde(rename = "MatchID")]
    match_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct NameServiceEntry {
    #[serde(rename = "Subject")]
    subject: String,
    #[serde(rename = "GameName")]
    game_name: Option<String>,
    #[serde(rename = "TagLine")]
    tag_line: Option<String>,
    #[serde(rename = "DisplayName", default)]
    display_name: Option<String>,
}

fn open_shared_file(path: &PathBuf) -> std::io::Result<std::fs::File> {
    let mut opts = OpenOptions::new();
    opts.read(true);
    #[cfg(target_os = "windows")]
    {
        // FILE_SHARE_READ (1) | FILE_SHARE_WRITE (2) | FILE_SHARE_DELETE (4)
        opts.share_mode(1 | 2 | 4);
    }
    opts.open(path)
}

fn get_local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

pub(crate) struct LockfileInfo {
    pub(crate) port: String,
    pub(crate) password: String,
}

pub(crate) fn read_lockfile() -> Option<LockfileInfo> {
    let base = get_local_app_data()?;
    let path = base
        .join("Riot Games")
        .join("Riot Client")
        .join("Config")
        .join("lockfile");
    let mut file = open_shared_file(&path).ok()?;
    let mut content = String::new();
    file.read_to_string(&mut content).ok()?;
    let parts: Vec<&str> = content.trim().split(':').collect();
    if parts.len() < 5 {
        return None;
    }
    Some(LockfileInfo {
        port: parts[2].to_string(),
        password: parts[3].to_string(),
    })
}

pub(crate) struct LogDiscovery {
    pub(crate) glz_region: Option<String>,
    pub(crate) shard: Option<String>,
    pub(crate) client_version: Option<String>,
}

pub(crate) fn scan_shooter_game_log() -> LogDiscovery {
    let mut out = LogDiscovery {
        glz_region: None,
        shard: None,
        client_version: None,
    };

    let Some(base) = get_local_app_data() else {
        return out;
    };
    let log_path = base
        .join("VALORANT")
        .join("Saved")
        .join("Logs")
        .join("ShooterGame.log");

    let Ok(file) = open_shared_file(&log_path) else {
        return out;
    };

    let reader = BufReader::new(file);
    for line_res in reader.lines().take(50_000) {
        let Ok(line) = line_res else { continue };

        if out.glz_region.is_none() {
            if let Some(start_idx) = line.find("https://glz-") {
                let rest = &line[start_idx + "https://glz-".len()..];
                if let Some(end_idx) = rest.find(".a.pvp.net") {
                    let middle = &rest[..end_idx]; // e.g. "ap-1.ap" or "latam-1.na"
                    if let Some((reg, sh)) = middle.split_once("-1.") {
                        if !reg.is_empty() && !sh.is_empty() {
                            out.glz_region = Some(reg.to_lowercase());
                            out.shard = Some(sh.to_lowercase());
                        }
                    }
                }
            }
        }

        if out.client_version.is_none() {
            if let Some(idx) = line.find("CI server version: ") {
                let raw_ver = line[idx + "CI server version: ".len()..].trim();
                if !raw_ver.is_empty() {
                    // Convert e.g. "release-09.10-29-2985574" -> "release-09.10-shipping-29-2985574" if needed
                    let normalized = if raw_ver.contains("-shipping-") {
                        raw_ver.to_string()
                    } else {
                        let segs: Vec<&str> = raw_ver.split('-').collect();
                        if segs.len() == 4 && segs[0] == "release" {
                            format!("{}-{}-shipping-{}-{}", segs[0], segs[1], segs[2], segs[3])
                        } else {
                            raw_ver.to_string()
                        }
                    };
                    out.client_version = Some(normalized);
                }
            }
        }

        if out.glz_region.is_some() && out.client_version.is_some() {
            break;
        }
    }

    out
}

pub(crate) async fn resolve_client_version(remote_client: &reqwest::Client, log_ver: Option<String>) -> String {
    let lock = CACHED_CLIENT_VERSION.get_or_init(|| tokio::sync::Mutex::new(None));
    {
        let guard = lock.lock().await;
        if let Some(v) = guard.as_ref() {
            return v.clone();
        }
    }

    if let Ok(resp) = remote_client
        .get("https://valorant-api.com/v1/version")
        .send()
        .await
    {
        if let Ok(json) = resp.json::<Value>().await {
            if let Some(v) = json
                .get("data")
                .and_then(|d| d.get("riotClientVersion"))
                .and_then(|v| v.as_str())
            {
                let ver = v.to_string();
                let mut guard = lock.lock().await;
                *guard = Some(ver.clone());
                return ver;
            }
        }
    }

    log_ver.unwrap_or_else(|| "release-10.00-shipping-10-3000000".to_string())
}

pub(crate) fn fallback_glz_and_shard(region: &str) -> (String, String) {
    match region.trim().to_lowercase().as_str() {
        "eu" => ("eu".to_string(), "eu".to_string()),
        "na" => ("na".to_string(), "na".to_string()),
        "kr" => ("kr".to_string(), "kr".to_string()),
        "latam" => ("latam".to_string(), "na".to_string()),
        "br" => ("br".to_string(), "na".to_string()),
        _ => ("ap".to_string(), "ap".to_string()),
    }
}

fn format_pod_name(pod_id: &str) -> String {
    let lower = pod_id.to_lowercase();
    if lower.contains("tokyo") {
        return "Tokyo".to_string();
    }
    if lower.contains("singapore") {
        return "Singapore".to_string();
    }
    if lower.contains("hongkong") || lower.contains("hong-kong") {
        return "Hong Kong".to_string();
    }
    if lower.contains("sydney") {
        return "Sydney".to_string();
    }
    if lower.contains("mumbai") {
        return "Mumbai".to_string();
    }
    if lower.contains("seoul") {
        return "Seoul".to_string();
    }
    pod_id
        .rsplit('.')
        .next()
        .unwrap_or(pod_id)
        .to_string()
}

fn service_entry_name(entry: &NameServiceEntry) -> Option<(String, String)> {
    let game = entry.game_name.as_deref().unwrap_or("").trim();
    let tag = entry.tag_line.as_deref().unwrap_or("").trim();
    if !game.is_empty() {
        return Some((game.to_string(), tag.to_string()));
    }

    // Some responses only fill DisplayName ("Name#TAG").
    let display = entry.display_name.as_deref().unwrap_or("").trim();
    if let Some((name, tag)) = display.split_once('#') {
        if !name.trim().is_empty() {
            return Some((name.trim().to_string(), tag.trim().to_string()));
        }
    }
    if display.is_empty() {
        None
    } else {
        Some((display.to_string(), String::new()))
    }
}

/// Riot replaces hidden (incognito) Riot IDs with generic names such as
/// "Player 1" or "Player01". Those carry no identity, so treat them as missing.
fn is_generic_name(name: &str) -> bool {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return true;
    }
    let compact: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    let lower = compact.to_lowercase();
    if let Some(rest) = lower.strip_prefix("player") {
        return rest.chars().all(|c| c.is_ascii_digit());
    }
    if let Some(rest) = lower.strip_prefix("プレイヤー") {
        return rest
            .chars()
            .all(|c| c.is_ascii_digit() || ('０'..='９').contains(&c));
    }
    false
}

/// Some payloads still carry the Riot ID inline (party members, friends) even
/// when the cloud name service masks it. Read whichever field is present.
fn identity_name(p: &Value) -> Option<(String, String)> {
    let identity = p.get("PlayerIdentity");
    for source in [Some(p), identity] {
        let Some(source) = source else { continue };
        let game = source
            .get("GameName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let tag = source
            .get("TagLine")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if !is_generic_name(game) {
            return Some((game.to_string(), tag.to_string()));
        }

        let display = source
            .get("DisplayName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if let Some((name, tag)) = display.split_once('#') {
            if !is_generic_name(name) {
                return Some((name.trim().to_string(), tag.trim().to_string()));
            }
        }
    }
    None
}

/// Prefer the name-service result, then the identity embedded in the match
/// payload, so incognito players never end up as a bare "Player".
fn resolve_player_name(
    name_map: &HashMap<String, (String, String)>,
    puuid: &str,
    p: &Value,
) -> (String, String) {
    if let Some(pair) = name_map.get(&puuid.to_lowercase()) {
        if !is_generic_name(&pair.0) {
            return pair.clone();
        }
    }
    if let Some(pair) = identity_name(p) {
        return pair;
    }
    ("Player".to_string(), String::new())
}

/// Reads identities known to the local Riot client (chat participants,
/// presence and friends). Unlike the cloud name service this is not affected
/// by the incognito display filter.
async fn fetch_local_identity_names() -> HashMap<String, (String, String)> {
    let mut map = HashMap::new();
    let Some(lock) = read_lockfile() else {
        return map;
    };
    let Ok(client) = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(4))
        .build()
    else {
        return map;
    };

    let basic = BASE64.encode(format!("riot:{}", lock.password));
    let endpoints = [
        ("/chat/v5/participants", "participants"),
        ("/chat/v4/participants", "participants"),
        ("/chat/v4/presences", "presences"),
        ("/chat/v4/friends", "friends"),
    ];

    for (path, list_key) in endpoints {
        let url = format!("https://127.0.0.1:{}{}", lock.port, path);
        let Ok(resp) = client
            .get(&url)
            .header(AUTHORIZATION, format!("Basic {basic}"))
            .send()
            .await
        else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(json) = resp.json::<Value>().await else {
            continue;
        };
        let Some(list) = json.get(list_key).and_then(|v| v.as_array()) else {
            continue;
        };

        for entry in list {
            let puuid = entry.get("puuid").and_then(|v| v.as_str()).unwrap_or("");
            let game = entry
                .get("game_name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let tag = entry
                .get("game_tag")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if puuid.is_empty() || is_generic_name(game) {
                continue;
            }
            map.entry(puuid.to_lowercase())
                .or_insert_with(|| (game.to_string(), tag.to_string()));
        }
    }

    map
}

async fn resolve_names(
    remote_client: &reqwest::Client,
    shard: &str,
    headers: &HeaderMap,
    puuids: &[String],
) -> HashMap<String, (String, String)> {
    let mut map = HashMap::new();
    if puuids.is_empty() {
        return map;
    }

    let url = format!("https://pd.{shard}.a.pvp.net/name-service/v2/players");
    if let Ok(resp) = remote_client
        .put(&url)
        .headers(headers.clone())
        .json(puuids)
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(entries) = resp.json::<Vec<NameServiceEntry>>().await {
                for entry in entries {
                    if let Some((game_name, tag_line)) = service_entry_name(&entry) {
                        if !is_generic_name(&game_name) {
                            map.insert(entry.subject.to_lowercase(), (game_name, tag_line));
                        }
                    }
                }
            }
        }
    }

    // Hidden players come back without a name (or with a generic one). Fill the
    // gaps from the local client, which still knows the identity behind each
    // PUUID for chat/presence.
    let needs_more = puuids
        .iter()
        .any(|puuid| !map.contains_key(&puuid.to_lowercase()));
    if needs_more {
        for (puuid, (game_name, tag_line)) in fetch_local_identity_names().await {
            if is_generic_name(&game_name) {
                continue;
            }
            match map.get(&puuid) {
                Some((existing, _)) if !is_generic_name(existing) => {}
                _ => {
                    map.insert(puuid, (game_name, tag_line));
                }
            }
        }
    }

    map
}

#[derive(Debug, Deserialize)]
struct PartyPlayerResp {
    #[serde(rename = "CurrentPartyID")]
    current_party_id: Option<String>,
}

struct PartySnapshot {
    players: Vec<LiveMatchPlayerRaw>,
    queue_id: Option<String>,
    mode_id: Option<String>,
    map_url: Option<String>,
}

fn is_zero_guid(value: &str) -> bool {
    value.is_empty() || value.chars().all(|c| c == '0' || c == '-')
}

/// Reads the current party (client lobby) roster. The player stays "IN_MENU"
/// while waiting, but we can still list everyone who is in the lobby.
async fn fetch_party_snapshot(
    remote_client: &reqwest::Client,
    shard: &str,
    glz_region: &str,
    headers: &HeaderMap,
    self_puuid: &str,
) -> PartySnapshot {
    let empty = PartySnapshot {
        players: Vec::new(),
        queue_id: None,
        mode_id: None,
        map_url: None,
    };

    let glz_base = format!("https://glz-{glz_region}-1.{shard}.a.pvp.net");
    let player_url = format!("{glz_base}/parties/v1/players/{self_puuid}");
    let party_id = match remote_client
        .get(&player_url)
        .headers(headers.clone())
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.json::<PartyPlayerResp>().await {
            Ok(p) => p.current_party_id.unwrap_or_default(),
            Err(_) => String::new(),
        },
        _ => String::new(),
    };

    if is_zero_guid(&party_id) {
        return empty;
    }

    let party_url = format!("{glz_base}/parties/v1/parties/{party_id}");
    let party = match remote_client
        .get(&party_url)
        .headers(headers.clone())
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(v) => v,
            Err(_) => return empty,
        },
        _ => return empty,
    };

    let members = party
        .get("Members")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let puuids: Vec<String> = members
        .iter()
        .filter_map(|p| p.get("Subject").and_then(|v| v.as_str()).map(String::from))
        .collect();
    let name_map = resolve_names(remote_client, shard, headers, &puuids).await;

    let self_lower = self_puuid.to_lowercase();
    let mut players = Vec::new();
    for p in &members {
        let puuid = p.get("Subject").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if puuid.is_empty() {
            continue;
        }

        let identity = p.get("PlayerIdentity");
        let account_level = identity
            .and_then(|id| id.get("AccountLevel"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let hide_account_level = identity
            .and_then(|id| id.get("HideAccountLevel"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let is_incognito = identity
            .and_then(|id| id.get("Incognito"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let card_id = identity
            .and_then(|id| id.get("PlayerCardID"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let (game_name, tag_line) = resolve_player_name(&name_map, &puuid, p);

        players.push(LiveMatchPlayerRaw {
            puuid: puuid.clone(),
            game_name,
            tag_line,
            team_id: "party".to_string(),
            is_ally: true,
            is_self: puuid.eq_ignore_ascii_case(&self_lower),
            agent_id: String::new(),
            selection_state: String::new(),
            account_level,
            hide_account_level,
            is_incognito,
            card_id,
            pregame_tier: p
                .get("CompetitiveTier")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            party_ready: p.get("IsReady").and_then(|v| v.as_bool()),
            is_party_owner: p.get("IsOwner").and_then(|v| v.as_bool()),
        });
    }

    let queue_id = party
        .get("MatchmakingData")
        .and_then(|v| v.get("QueueID"))
        .and_then(|v| v.as_str())
        .map(String::from);

    let custom = party.get("CustomGameData").and_then(|v| v.get("Settings"));
    let mode_id = custom
        .and_then(|v| v.get("Mode"))
        .and_then(|v| v.as_str())
        .filter(|v| !is_zero_guid(v))
        .map(String::from);
    let map_url = custom
        .and_then(|v| v.get("Map"))
        .and_then(|v| v.as_str())
        .filter(|v| !is_zero_guid(v))
        .map(String::from);

    PartySnapshot {
        players,
        queue_id,
        mode_id,
        map_url,
    }
}

#[tauri::command]
pub async fn fetch_live_match(region_fallback: String) -> Result<LiveMatchResponse, String> {
    let Some(lock) = read_lockfile() else {
        return Ok(LiveMatchResponse {
            status: "NOT_RUNNING".to_string(),
            message: Some("VALORANT（Riot Client）が起動していません。ゲームを起動してから再取得してください。".to_string()),
            match_id: None,
            map_url: None,
            mode_id: None,
            queue_id: None,
            server_pod: None,
            detected_region: None,
            detected_shard: None,
            self_puuid: None,
            ally_side: None,
            players: Vec::new(),
        });
    };

    let local_client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| format!("ローカルHTTPクライアント初期化エラー: {e}"))?;

    let remote_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| format!("HTTPクライアント初期化エラー: {e}"))?;

    let basic_auth = BASE64.encode(format!("riot:{}", lock.password));
    let token_url = format!("https://127.0.0.1:{}/entitlements/v1/token", lock.port);

    let token_resp = match local_client
        .get(&token_url)
        .header(AUTHORIZATION, format!("Basic {basic_auth}"))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.json::<EntitlementsTokenResp>().await {
            Ok(data) => data,
            Err(_) => {
                return Ok(LiveMatchResponse {
                    status: "NOT_RUNNING".to_string(),
                    message: Some("Riot Client にログインしていません。VALORANT を起動してください。".to_string()),
                    match_id: None,
                    map_url: None,
                    mode_id: None,
                    queue_id: None,
                    server_pod: None,
                    detected_region: None,
                    detected_shard: None,
                    self_puuid: None,
                    ally_side: None,
                    players: Vec::new(),
                });
            }
        },
        _ => {
            return Ok(LiveMatchResponse {
                status: "NOT_RUNNING".to_string(),
                message: Some("VALORANT クライアントとの接続に失敗しました。ゲームが起動中か確認してください。".to_string()),
                match_id: None,
                map_url: None,
                mode_id: None,
                queue_id: None,
                server_pod: None,
                detected_region: None,
                detected_shard: None,
                self_puuid: None,
                ally_side: None,
                players: Vec::new(),
            });
        }
    };

    let self_puuid = token_resp.subject.clone();
    let log_info = scan_shooter_game_log();
    let (fb_glz, fb_shard) = fallback_glz_and_shard(&region_fallback);
    let glz_region = log_info.glz_region.unwrap_or(fb_glz);
    let shard = log_info.shard.unwrap_or(fb_shard);
    let client_version = resolve_client_version(&remote_client, log_info.client_version).await;

    let mut riot_headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", token_resp.access_token)) {
        riot_headers.insert(AUTHORIZATION, v);
    }
    if let Ok(v) = HeaderValue::from_str(&token_resp.token) {
        riot_headers.insert("X-Riot-Entitlements-JWT", v);
    }
    if let Ok(v) = HeaderValue::from_str(&client_version) {
        riot_headers.insert("X-Riot-ClientVersion", v);
    }
    riot_headers.insert(
        "X-Riot-ClientPlatform",
        HeaderValue::from_static(CLIENT_PLATFORM_B64),
    );

    let glz_base = format!("https://glz-{glz_region}-1.{shard}.a.pvp.net");

    // 1. Check Core-Game (Active Match)
    let core_player_url = format!("{glz_base}/core-game/v1/players/{self_puuid}");
    if let Ok(r) = remote_client
        .get(&core_player_url)
        .headers(riot_headers.clone())
        .send()
        .await
    {
        if r.status().is_success() {
            if let Ok(pm) = r.json::<PlayerMatchResp>().await {
                if let Some(match_id) = pm.match_id.filter(|id| !id.is_empty()) {
                    let match_url = format!("{glz_base}/core-game/v1/matches/{match_id}");
                    if let Ok(mr) = remote_client
                        .get(&match_url)
                        .headers(riot_headers.clone())
                        .send()
                        .await
                    {
                        if mr.status().is_success() {
                            if let Ok(mjson) = mr.json::<Value>().await {
                                return Ok(build_core_game_response(
                                    &remote_client,
                                    &shard,
                                    &glz_region,
                                    &riot_headers,
                                    &self_puuid,
                                    &match_id,
                                    &mjson,
                                )
                                .await);
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Check Pre-Game (Agent Select)
    let pre_player_url = format!("{glz_base}/pregame/v1/players/{self_puuid}");
    if let Ok(r) = remote_client
        .get(&pre_player_url)
        .headers(riot_headers.clone())
        .send()
        .await
    {
        if r.status().is_success() {
            if let Ok(pm) = r.json::<PlayerMatchResp>().await {
                if let Some(match_id) = pm.match_id.filter(|id| !id.is_empty()) {
                    let match_url = format!("{glz_base}/pregame/v1/matches/{match_id}");
                    if let Ok(mr) = remote_client
                        .get(&match_url)
                        .headers(riot_headers.clone())
                        .send()
                        .await
                    {
                        if mr.status().is_success() {
                            if let Ok(mjson) = mr.json::<Value>().await {
                                return Ok(build_pregame_response(
                                    &remote_client,
                                    &shard,
                                    &glz_region,
                                    &riot_headers,
                                    &self_puuid,
                                    &match_id,
                                    &mjson,
                                )
                                .await);
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Not in a match: read the party lobby roster so the client lobby is
    // still useful (who is in the party, ranks, ready state).
    let party = fetch_party_snapshot(
        &remote_client,
        &shard,
        &glz_region,
        &riot_headers,
        &self_puuid,
    )
    .await;

    Ok(LiveMatchResponse {
        status: "IN_MENU".to_string(),
        message: Some(if party.players.is_empty() {
            "VALORANT 起動中（現在マッチには入っていません）。エージェント選択または試合が始まると表示されます。"
                .to_string()
        } else {
            "ロビー待機中。パーティメンバーを表示しています。".to_string()
        }),
        match_id: None,
        map_url: party.map_url,
        mode_id: party.mode_id,
        queue_id: party.queue_id,
        server_pod: None,
        detected_region: Some(glz_region),
        detected_shard: Some(shard),
        self_puuid: Some(self_puuid),
        ally_side: None,
        players: party.players,
    })
}

async fn build_core_game_response(
    remote_client: &reqwest::Client,
    shard: &str,
    glz_region: &str,
    headers: &HeaderMap,
    self_puuid: &str,
    match_id: &str,
    mjson: &Value,
) -> LiveMatchResponse {
    let map_url = mjson.get("MapID").and_then(|v| v.as_str()).map(String::from);
    let mode_id = mjson.get("ModeID").and_then(|v| v.as_str()).map(String::from);
    let pod_raw = mjson.get("GamePodID").and_then(|v| v.as_str()).unwrap_or("");
    let server_pod = if pod_raw.is_empty() {
        None
    } else {
        Some(format_pod_name(pod_raw))
    };

    let raw_players = mjson
        .get("Players")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let self_lower = self_puuid.to_lowercase();
    let mut self_team = String::new();
    for p in &raw_players {
        let sub = p.get("Subject").and_then(|v| v.as_str()).unwrap_or("");
        if sub.eq_ignore_ascii_case(&self_lower) {
            self_team = p.get("TeamID").and_then(|v| v.as_str()).unwrap_or("").to_string();
            break;
        }
    }

    let puuids: Vec<String> = raw_players
        .iter()
        .filter(|p| !p.get("IsCoach").and_then(|v| v.as_bool()).unwrap_or(false))
        .filter_map(|p| p.get("Subject").and_then(|v| v.as_str()).map(String::from))
        .collect();

    let name_map = resolve_names(remote_client, shard, headers, &puuids).await;

    let mut players = Vec::new();
    for p in &raw_players {
        if p.get("IsCoach").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let puuid = p.get("Subject").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if puuid.is_empty() {
            continue;
        }
        let team_id = p.get("TeamID").and_then(|v| v.as_str()).unwrap_or("Neutral").to_string();
        let is_self = puuid.eq_ignore_ascii_case(&self_lower);
        let is_ally = if self_team.is_empty() {
            is_self
        } else {
            team_id.eq_ignore_ascii_case(&self_team)
        };

        let identity = p.get("PlayerIdentity");
        let account_level = identity
            .and_then(|id| id.get("AccountLevel"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let hide_account_level = identity
            .and_then(|id| id.get("HideAccountLevel"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let is_incognito = identity
            .and_then(|id| id.get("Incognito"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let card_id = identity
            .and_then(|id| id.get("PlayerCardID"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let (game_name, tag_line) = resolve_player_name(&name_map, &puuid, p);

        players.push(LiveMatchPlayerRaw {
            puuid,
            game_name,
            tag_line,
            team_id,
            is_ally,
            is_self,
            agent_id: p
                .get("CharacterID")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            selection_state: "locked".to_string(),
            account_level,
            hide_account_level,
            is_incognito,
            card_id,
            pregame_tier: 0,
            party_ready: None,
            is_party_owner: None,
        });
    }

    LiveMatchResponse {
        status: "IN_GAME".to_string(),
        message: None,
        match_id: Some(match_id.to_string()),
        map_url,
        mode_id,
        queue_id: None,
        server_pod,
        detected_region: Some(glz_region.to_string()),
        detected_shard: Some(shard.to_string()),
        self_puuid: Some(self_puuid.to_string()),
        ally_side: None,
        players,
    }
}

async fn build_pregame_response(
    remote_client: &reqwest::Client,
    shard: &str,
    glz_region: &str,
    headers: &HeaderMap,
    self_puuid: &str,
    match_id: &str,
    mjson: &Value,
) -> LiveMatchResponse {
    let map_url = mjson.get("MapID").and_then(|v| v.as_str()).map(String::from);
    let mode_id = mjson.get("Mode").and_then(|v| v.as_str()).map(String::from);
    let queue_id = mjson.get("QueueID").and_then(|v| v.as_str()).map(String::from);
    let pod_raw = mjson.get("GamePodID").and_then(|v| v.as_str()).unwrap_or("");
    let server_pod = if pod_raw.is_empty() {
        None
    } else {
        Some(format_pod_name(pod_raw))
    };

    let self_lower = self_puuid.to_lowercase();

    // Collect players from the Teams array, then fill in anything that only
    // shows up under AllyTeam / EnemyTeam (some pregame payloads omit the
    // enemy team from `Teams`).
    let mut team_entries: Vec<(String, Value)> = Vec::new();
    let mut seen_puuids: HashSet<String> = HashSet::new();
    let mut push_team = |tid: &str, team: &Value| {
        if let Some(plist) = team.get("Players").and_then(|v| v.as_array()) {
            for p in plist {
                let sub = p
                    .get("Subject")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_lowercase();
                if !sub.is_empty() && !seen_puuids.insert(sub) {
                    continue;
                }
                team_entries.push((tid.to_string(), p.clone()));
            }
        }
    };

    if let Some(teams) = mjson.get("Teams").and_then(|v| v.as_array()) {
        for t in teams {
            let tid = t.get("TeamID").and_then(|v| v.as_str()).unwrap_or("Blue");
            push_team(tid, t);
        }
    }
    for key in ["AllyTeam", "EnemyTeam"] {
        if let Some(team) = mjson.get(key) {
            let tid = team
                .get("TeamID")
                .and_then(|v| v.as_str())
                .unwrap_or("Blue");
            push_team(tid, team);
        }
    }

    let mut self_team = mjson
        .get("AllyTeam")
        .and_then(|a| a.get("TeamID"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if self_team.is_empty() {
        for (tid, p) in &team_entries {
            let sub = p.get("Subject").and_then(|v| v.as_str()).unwrap_or("");
            if sub.eq_ignore_ascii_case(&self_lower) {
                self_team = tid.clone();
                break;
            }
        }
    }

    let puuids: Vec<String> = team_entries
        .iter()
        .filter_map(|(_, p)| p.get("Subject").and_then(|v| v.as_str()).map(String::from))
        .collect();

    let name_map = resolve_names(remote_client, shard, headers, &puuids).await;

    let mut players = Vec::new();
    for (team_id, p) in &team_entries {
        let puuid = p.get("Subject").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if puuid.is_empty() {
            continue;
        }
        let is_self = puuid.eq_ignore_ascii_case(&self_lower);
        let is_ally = if self_team.is_empty() {
            true
        } else {
            team_id.eq_ignore_ascii_case(&self_team)
        };

        let identity = p.get("PlayerIdentity");
        let account_level = identity
            .and_then(|id| id.get("AccountLevel"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let hide_account_level = identity
            .and_then(|id| id.get("HideAccountLevel"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let is_incognito = identity
            .and_then(|id| id.get("Incognito"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let card_id = identity
            .and_then(|id| id.get("PlayerCardID"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let (game_name, tag_line) = resolve_player_name(&name_map, &puuid, p);

        players.push(LiveMatchPlayerRaw {
            puuid,
            game_name,
            tag_line,
            team_id: team_id.clone(),
            is_ally,
            is_self,
            agent_id: p
                .get("CharacterID")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            selection_state: p
                .get("CharacterSelectionState")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            account_level,
            hide_account_level,
            is_incognito,
            card_id,
            pregame_tier: p
                .get("CompetitiveTier")
                .and_then(|v| v.as_i64())
                .unwrap_or(0),
            party_ready: None,
            is_party_owner: None,
        });
    }

    let ally_side = if self_team.eq_ignore_ascii_case("Red") {
        Some("attack".to_string())
    } else if self_team.eq_ignore_ascii_case("Blue") {
        Some("defense".to_string())
    } else {
        None
    };

    LiveMatchResponse {
        status: "PREGAME".to_string(),
        message: None,
        match_id: Some(match_id.to_string()),
        map_url,
        mode_id,
        queue_id,
        server_pod,
        detected_region: Some(glz_region.to_string()),
        detected_shard: Some(shard.to_string()),
        self_puuid: Some(self_puuid.to_string()),
        ally_side,
        players,
    }
}

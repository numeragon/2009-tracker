use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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
    /// Party ID shared by the player's premade group. Exact for your own party
    /// and for allies seen in the local presence feed, `h:`-prefixed and
    /// `party_inferred` when guessed from shared match history.
    pub party_id: Option<String>,
    /// Number of players in the same resolved party (1 when solo).
    pub party_size: usize,
    /// True when the group comes from match-history inference, not Riot data.
    pub party_inferred: bool,
    pub is_party_member: bool,
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

#[derive(Clone)]
pub(crate) struct LogDiscovery {
    pub(crate) glz_region: Option<String>,
    pub(crate) shard: Option<String>,
    pub(crate) client_version: Option<String>,
}

static LOG_CACHE: OnceLock<Mutex<Option<(LogDiscovery, Instant)>>> = OnceLock::new();

fn log_cache() -> &'static Mutex<Option<(LogDiscovery, Instant)>> {
    LOG_CACHE.get_or_init(|| Mutex::new(None))
}

/// ShooterGame.log can be tens of MB, so keep the parsed result briefly: a
/// live match refresh resolves stats for up to ten players in a row.
pub(crate) fn scan_shooter_game_log() -> LogDiscovery {
    if let Ok(guard) = log_cache().lock() {
        if let Some((info, at)) = guard.as_ref() {
            if at.elapsed() < Duration::from_secs(5) {
                return info.clone();
            }
        }
    }
    let info = scan_shooter_game_log_uncached();
    if let Ok(mut guard) = log_cache().lock() {
        *guard = Some((info.clone(), Instant::now()));
    }
    info
}

fn scan_shooter_game_log_uncached() -> LogDiscovery {
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

/* ---------- Persistent player-name cache ---------- */

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct NameCacheEntry {
    game: String,
    tag: String,
}

fn name_cache_path() -> Option<PathBuf> {
    get_local_app_data().map(|base| base.join("2009-tracker").join("name_cache.json"))
}

static NAME_DB: OnceLock<Mutex<Option<HashMap<String, NameCacheEntry>>>> = OnceLock::new();

fn name_db() -> &'static Mutex<Option<HashMap<String, NameCacheEntry>>> {
    NAME_DB.get_or_init(|| Mutex::new(None))
}

fn load_name_db() -> HashMap<String, NameCacheEntry> {
    let Some(path) = name_cache_path() else {
        return HashMap::new();
    };
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return HashMap::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_name_db(map: &HashMap<String, NameCacheEntry>) {
    let Some(path) = name_cache_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_vec(map) {
        let _ = std::fs::write(path, json);
    }
}

fn name_db_get(puuid: &str) -> Option<(String, String)> {
    let key = puuid.to_lowercase();
    let mut guard = name_db().lock().ok()?;
    if guard.is_none() {
        *guard = Some(load_name_db());
    }
    let entry = guard.as_ref()?.get(&key)?;
    if is_generic_name(&entry.game) {
        return None;
    }
    Some((entry.game.clone(), entry.tag.clone()))
}

fn name_db_store_many(entries: &HashMap<String, (String, String)>) {
    if entries.is_empty() {
        return;
    }
    let mut guard = match name_db().lock() {
        Ok(guard) => guard,
        Err(_) => return,
    };
    if guard.is_none() {
        *guard = Some(load_name_db());
    }
    let Some(map) = guard.as_mut() else {
        return;
    };
    let mut changed = false;
    for (puuid, (game, tag)) in entries {
        if game.trim().is_empty() || is_generic_name(game) {
            continue;
        }
        let key = puuid.to_lowercase();
        if map.get(&key).map(|e| e.game == *game).unwrap_or(false) {
            continue;
        }
        map.insert(
            key,
            NameCacheEntry {
                game: game.clone(),
                tag: tag.clone(),
            },
        );
        changed = true;
    }
    if changed {
        if map.len() > 5000 {
            let keep: HashMap<String, NameCacheEntry> = map
                .iter()
                .take(5000)
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            *map = keep;
        }
        write_name_db(map);
    }
}

static HENRIK_KEY: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static HENRIK_REGION: OnceLock<Mutex<String>> = OnceLock::new();

fn henrik_api_key() -> Option<String> {
    HENRIK_KEY
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

fn henrik_region() -> String {
    HENRIK_REGION
        .get_or_init(|| Mutex::new(String::new()))
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default()
}

const HENRIK_MISS_TTL: Duration = Duration::from_secs(600);

static HENRIK_MISSES: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();

fn henrik_misses() -> &'static Mutex<HashMap<String, Instant>> {
    HENRIK_MISSES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Agent select polls every 2 seconds; without a negative cache an unresolved
/// player would burn a HenrikDev request on every tick.
fn henrik_miss_recent(puuid: &str) -> bool {
    henrik_misses()
        .lock()
        .ok()
        .and_then(|guard| guard.get(puuid).copied())
        .map(|at| at.elapsed() < HENRIK_MISS_TTL)
        .unwrap_or(false)
}

fn mark_henrik_miss(puuid: &str) {
    if let Ok(mut guard) = henrik_misses().lock() {
        guard.insert(puuid.to_string(), Instant::now());
    }
}

/// Riot's public name lookup by PUUID is not affected by the incognito display
/// filter, so this is what actually reveals hidden names. Only called for
/// players that every local source failed to resolve, and the result is stored
/// in the persistent name cache.
async fn henrik_name_at(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    pointer: &str,
) -> Option<(String, String)> {
    let resp = client
        .get(url)
        .header(AUTHORIZATION, api_key)
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let json = resp.json::<Value>().await.ok()?;
    let account = json.pointer(pointer)?;
    let game = account
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let tag = account
        .get("tag")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if game.is_empty() || is_generic_name(game) {
        return None;
    }
    Some((game.to_string(), tag.to_string()))
}

async fn henrik_account_name(
    client: &reqwest::Client,
    puuid: &str,
    api_key: &str,
) -> Option<(String, String)> {
    let region = henrik_region();
    let region = if region.is_empty() { "ap".to_string() } else { region };

    // MMR v3 carries the account document; fall back to the account endpoint
    // for players without a competitive record.
    let mmr_url =
        format!("https://api.henrikdev.xyz/valorant/v3/by-puuid/mmr/{region}/pc/{puuid}");
    if let Some(pair) = henrik_name_at(client, &mmr_url, api_key, "/data/account").await {
        return Some(pair);
    }
    let account_url =
        format!("https://api.henrikdev.xyz/valorant/v1/by-puuid/account/{puuid}");
    henrik_name_at(client, &account_url, api_key, "/data").await
}

async fn resolve_names(
    remote_client: &reqwest::Client,
    shard: &str,
    headers: &HeaderMap,
    puuids: &[String],
) -> HashMap<String, (String, String)> {
    if puuids.is_empty() {
        return HashMap::new();
    }

    let mut map = name_service_lookup(remote_client, shard, headers, puuids).await;

    // Riot sometimes masks a batched lookup while a single lookup still
    // returns the real Riot ID, so retry the remaining players one by one.
    let missing: Vec<String> = puuids
        .iter()
        .filter(|puuid| !map.contains_key(&puuid.to_lowercase()))
        .cloned()
        .collect();
    for puuid in missing.iter().take(3) {
        let single = name_service_lookup(
            remote_client,
            shard,
            headers,
            std::slice::from_ref(puuid),
        )
        .await;
        if let Some((key, value)) = single.into_iter().next() {
            map.insert(key, value);
        }
    }

    // Hidden players come back without a name (or with a generic one). Fill the
    // gaps from the local client, which still knows the identity behind each
    // PUUID for chat/presence.
    let needs_local = puuids
        .iter()
        .any(|puuid| !map.contains_key(&puuid.to_lowercase()));
    if needs_local {
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

    // Persistent cache: names revealed in earlier sessions (post-match
    // scoreboards are not masked) resolve instantly and for free.
    for puuid in puuids {
        if map.contains_key(&puuid.to_lowercase()) {
            continue;
        }
        if let Some(pair) = name_db_get(puuid) {
            map.insert(puuid.to_lowercase(), pair);
        }
    }

    // Older matches may still store the real Riot ID in `match-details`.
    reveal_names_from_history(remote_client, shard, headers, puuids, &mut map).await;

    // Riot's PUUID lookup (via HenrikDev) is not affected by incognito mode,
    // so this is what actually breaks the display filter. Only used for
    // players no local source could resolve, and cached forever afterwards.
    if let Some(api_key) = henrik_api_key() {
        let mut lookups = 0usize;
        for puuid in puuids {
            let key = puuid.to_lowercase();
            if map.contains_key(&key) {
                continue;
            }
            if lookups >= 5 {
                break;
            }
            if henrik_miss_recent(&key) {
                continue;
            }
            lookups += 1;
            if let Some(pair) = henrik_account_name(remote_client, puuid, &api_key).await {
                map.insert(key, pair);
            } else {
                mark_henrik_miss(&key);
            }
        }
    }

    name_db_store_many(&map);
    map
}

async fn name_service_lookup(
    client: &reqwest::Client,
    shard: &str,
    headers: &HeaderMap,
    puuids: &[String],
) -> HashMap<String, (String, String)> {
    let mut map = HashMap::new();
    let url = format!("https://pd.{shard}.a.pvp.net/name-service/v2/players");
    let Ok(resp) = client
        .put(&url)
        .headers(headers.clone())
        .json(puuids)
        .send()
        .await
    else {
        return map;
    };
    if !resp.status().is_success() {
        return map;
    }
    let Ok(entries) = resp.json::<Vec<NameServiceEntry>>().await else {
        return map;
    };
    for entry in entries {
        if let Some((game_name, tag_line)) = service_entry_name(&entry) {
            if !is_generic_name(&game_name) {
                map.insert(entry.subject.to_lowercase(), (game_name, tag_line));
            }
        }
    }
    map
}

/// Number of history lookups per poll. The result is cached, so a lobby only
/// pays for this once per player.
const REVEAL_MAX_LOOKUPS: usize = 3;
const REVEAL_MATCHES_PER_PLAYER: usize = 3;
const REVEAL_MISS_TTL: Duration = Duration::from_secs(600);

struct RevealCacheEntry {
    name: Option<(String, String)>,
    checked_at: Instant,
}

static REVEAL_CACHE: OnceLock<Mutex<HashMap<String, RevealCacheEntry>>> = OnceLock::new();

fn reveal_cache() -> &'static Mutex<HashMap<String, RevealCacheEntry>> {
    REVEAL_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cached_revealed_name(puuid: &str) -> Option<Option<(String, String)>> {
    let guard = reveal_cache().lock().ok()?;
    let entry = guard.get(puuid)?;
    if entry.name.is_some() || entry.checked_at.elapsed() < REVEAL_MISS_TTL {
        Some(entry.name.clone())
    } else {
        None
    }
}

fn store_revealed_name(puuid: &str, name: Option<(String, String)>) {
    if let Ok(mut guard) = reveal_cache().lock() {
        guard.insert(
            puuid.to_string(),
            RevealCacheEntry {
                name,
                checked_at: Instant::now(),
            },
        );
    }
}

/// Reads the player's recent finished matches and takes the Riot ID stored in
/// the match document. Incognito only masks the live roster, so older matches
/// usually still contain the real name.
async fn reveal_name_from_history(
    client: &reqwest::Client,
    shard: &str,
    headers: &HeaderMap,
    puuid: &str,
) -> Option<(String, String)> {
    let history_url = format!(
        "https://pd.{shard}.a.pvp.net/match-history/v1/history/{puuid}?startIndex=0&endIndex=10"
    );
    let resp = client
        .get(&history_url)
        .headers(headers.clone())
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let history = resp.json::<Value>().await.ok()?;
    let match_ids: Vec<String> = history
        .get("History")
        .and_then(|v| v.as_array())?
        .iter()
        .filter_map(|m| m.get("MatchID").and_then(|v| v.as_str()).map(String::from))
        .take(REVEAL_MATCHES_PER_PLAYER)
        .collect();

    for match_id in match_ids {
        let details_url =
            format!("https://pd.{shard}.a.pvp.net/match-details/v1/matches/{match_id}");
        let Ok(resp) = client
            .get(&details_url)
            .headers(headers.clone())
            .send()
            .await
        else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(details) = resp.json::<Value>().await else {
            continue;
        };
        let Some(players) = details.get("players").and_then(|v| v.as_array()) else {
            continue;
        };
        for player in players {
            let subject = player.get("subject").and_then(|v| v.as_str()).unwrap_or("");
            if !subject.eq_ignore_ascii_case(puuid) {
                continue;
            }
            let game = player
                .get("gameName")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            let tag = player
                .get("tagLine")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if !is_generic_name(game) {
                return Some((game.to_string(), tag.to_string()));
            }
        }
    }

    None
}

async fn reveal_names_from_history(
    client: &reqwest::Client,
    shard: &str,
    headers: &HeaderMap,
    puuids: &[String],
    map: &mut HashMap<String, (String, String)>,
) {
    let mut lookups = 0usize;
    for puuid in puuids {
        let key = puuid.to_lowercase();
        if map.contains_key(&key) {
            continue;
        }
        if let Some(cached) = cached_revealed_name(&key) {
            if let Some(name) = cached {
                map.insert(key, name);
            }
            continue;
        }
        if lookups >= REVEAL_MAX_LOOKUPS {
            break;
        }
        lookups += 1;
        let name = reveal_name_from_history(client, shard, headers, puuid).await;
        store_revealed_name(&key, name.clone());
        if let Some(name) = name {
            map.insert(key, name);
        }
    }
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
#[derive(Default, Clone)]
struct PartyMembers {
    party_id: Option<String>,
    members: HashSet<String>,
    fetched_at: Option<Instant>,
}

static LAST_PARTY: OnceLock<Mutex<PartyMembers>> = OnceLock::new();

fn last_party() -> &'static Mutex<PartyMembers> {
    LAST_PARTY.get_or_init(|| Mutex::new(PartyMembers::default()))
}

fn cached_party() -> PartyMembers {
    last_party()
        .lock()
        .map(|party| party.clone())
        .unwrap_or_default()
}

/// Your own party id + member PUUIDs. Riot does not expose other players'
/// parties in the live match payload, so this is the group you queued with.
async fn fetch_party_members(
    client: &reqwest::Client,
    glz_base: &str,
    headers: &HeaderMap,
    self_puuid: &str,
) -> PartyMembers {
    let cached = cached_party();
    if cached.party_id.is_some()
        && cached
            .fetched_at
            .map(|at| at.elapsed() < Duration::from_secs(10))
            .unwrap_or(false)
    {
        return cached;
    }

    let player_url = format!("{glz_base}/parties/v1/players/{self_puuid}");
    let party_id = match client
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
        return cached_party();
    }

    let party_url = format!("{glz_base}/parties/v1/parties/{party_id}");
    let party = match client
        .get(&party_url)
        .headers(headers.clone())
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(v) => v,
            Err(_) => return cached_party(),
        },
        _ => return cached_party(),
    };

    let members: HashSet<String> = party
        .get("Members")
        .and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|m| {
                    m.get("Subject")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_lowercase())
                })
                .collect()
        })
        .unwrap_or_default();

    let result = PartyMembers {
        party_id: Some(party_id),
        members,
        fetched_at: Some(Instant::now()),
    };
    if let Ok(mut guard) = last_party().lock() {
        *guard = result.clone();
    }
    result
}

// ---------------------------------------------------------------------------
// Party resolution
//
// Riot only exposes your own party through the party service. Two other
// sources still let us show everyone else's premade:
//
//  * the local presence feed (`/chat/v4/presences`) carries the real party id
//    of every allied player in the match (exact, refreshed often);
//  * finished match details store the `partyId` each player queued with, so
//    players who shared a party in several recent matches are grouped as a
//    likely premade (inferred, labelled as such in the UI).
//
// The history pass is expensive (up to ten match documents per player), so it
// runs once per match in the background and is cached until the match changes.
// ---------------------------------------------------------------------------

const PARTY_PRESENCE_TTL: Duration = Duration::from_secs(20);
const PARTY_INFER_MATCHES: usize = 10;
const PARTY_INFER_MIN_SHARED: u32 = 2;
const PARTY_INFER_MAX_DETAILS: usize = 60;
const PARTY_INFER_RETRY: Duration = Duration::from_secs(300);

#[derive(Clone, Debug)]
struct PartyTag {
    id: String,
    inferred: bool,
}

#[derive(Default, Clone)]
struct PartyResolutionCache {
    match_key: String,
    presence: HashMap<String, String>,
    inferred: HashMap<String, String>,
    presence_fetched_at: Option<Instant>,
    inference_started_at: Option<Instant>,
}

static PARTY_RESOLUTION: OnceLock<Mutex<PartyResolutionCache>> = OnceLock::new();

fn party_resolution() -> &'static Mutex<PartyResolutionCache> {
    PARTY_RESOLUTION.get_or_init(|| Mutex::new(PartyResolutionCache::default()))
}

/// Reads the local presence feed and returns puuid -> party id for every
/// player the client can see (the whole allied team during a match).
async fn fetch_presence_party_map() -> HashMap<String, String> {
    let map = HashMap::new();
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
    let url = format!("https://127.0.0.1:{}/chat/v4/presences", lock.port);
    let Ok(resp) = client
        .get(&url)
        .header(AUTHORIZATION, format!("Basic {basic}"))
        .send()
        .await
    else {
        return map;
    };
    if !resp.status().is_success() {
        return map;
    }
    let Ok(body) = resp.json::<Value>().await else {
        return map;
    };
    parse_presence_parties(&body)
}

/// Parses `/chat/v4/presences` into puuid -> party id. Each presence carries a
/// base64 `private` blob; the party id lives under `partyPresenceData` on
/// current builds and at the root on older ones.
fn parse_presence_parties(body: &Value) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let presences = body
        .get("presences")
        .and_then(|v| v.as_array())
        .cloned()
        .or_else(|| body.as_array().cloned())
        .unwrap_or_default();

    for entry in presences {
        let Some(puuid) = entry.get("puuid").and_then(|v| v.as_str()) else {
            continue;
        };
        let Some(private) = entry.get("private").and_then(|v| v.as_str()) else {
            continue;
        };
        if private.is_empty() {
            continue;
        }
        let Ok(bytes) = BASE64.decode(private) else {
            continue;
        };
        let Ok(decoded) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let party = decoded
            .get("partyPresenceData")
            .and_then(|d| d.get("partyId"))
            .or_else(|| decoded.get("partyId"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if party.is_empty() || is_zero_guid(party) {
            continue;
        }
        map.insert(puuid.to_lowercase(), party.to_string());
    }
    map
}

/// Collects the party members of every player in one finished match document
/// and counts how often each pair of lobby players queued together.
fn count_party_pairs(
    detail: &Value,
    roster: &HashSet<String>,
    counts: &mut HashMap<(String, String), u32>,
) {
    let Some(players) = detail.get("players").and_then(|v| v.as_array()) else {
        return;
    };
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for player in players {
        let subject = player
            .get("subject")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        if subject.is_empty() || !roster.contains(&subject) {
            continue;
        }
        let party = player
            .get("partyId")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if party.is_empty() || is_zero_guid(party) {
            continue;
        }
        groups.entry(party.to_string()).or_default().push(subject);
    }

    for members in groups.values() {
        if members.len() < 2 {
            continue;
        }
        for i in 0..members.len() {
            for j in (i + 1)..members.len() {
                let (a, b) = if members[i] <= members[j] {
                    (members[i].clone(), members[j].clone())
                } else {
                    (members[j].clone(), members[i].clone())
                };
                *counts.entry((a, b)).or_insert(0) += 1;
            }
        }
    }
}

fn find_root(parent: &mut HashMap<String, String>, key: &str) -> String {
    let mut current = key.to_string();
    loop {
        let next = parent.get(&current).cloned().unwrap_or_else(|| current.clone());
        if next == current {
            return current;
        }
        // Path compression.
        parent.insert(current.clone(), next.clone());
        current = next;
    }
}

/// Union-find over the lobby roster: pairs that shared a party in at least
/// PARTY_INFER_MIN_SHARED recent matches are merged into one synthetic group.
fn group_by_pair_counts(
    puuids: &[String],
    counts: &HashMap<(String, String), u32>,
) -> HashMap<String, String> {
    let mut parent: HashMap<String, String> = puuids
        .iter()
        .map(|puuid| {
            let key = puuid.to_lowercase();
            (key.clone(), key)
        })
        .collect();

    for ((a, b), count) in counts {
        if *count < PARTY_INFER_MIN_SHARED || !parent.contains_key(a) || !parent.contains_key(b) {
            continue;
        }
        let root_a = find_root(&mut parent, a);
        let root_b = find_root(&mut parent, b);
        if root_a != root_b {
            parent.insert(root_b, root_a);
        }
    }

    let keys: Vec<String> = parent.keys().cloned().collect();
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for key in keys {
        let root = find_root(&mut parent, &key);
        groups.entry(root).or_default().push(key);
    }

    let mut out = HashMap::new();
    for members in groups.values() {
        if members.len() < 2 {
            continue;
        }
        let mut sorted = members.clone();
        sorted.sort();
        let id = format!("h:{}", sorted[0]);
        for member in sorted {
            out.insert(member, id.clone());
        }
    }
    out
}

/// Downloads recent match documents and infers which lobby players queued
/// together. Runs in the background; an empty map just means "no grouping
/// known yet".
async fn infer_parties_from_history(
    client: &reqwest::Client,
    shard: &str,
    headers: &HeaderMap,
    puuids: &[String],
) -> HashMap<String, String> {
    let roster: HashSet<String> = puuids.iter().map(|p| p.to_lowercase()).collect();
    let mut match_ids: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for puuid in puuids {
        let url = format!(
            "https://pd.{shard}.a.pvp.net/match-history/v1/history/{puuid}?startIndex=0&endIndex={PARTY_INFER_MATCHES}"
        );
        let Ok(resp) = client.get(&url).headers(headers.clone()).send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(history) = resp.json::<Value>().await else {
            continue;
        };
        let Some(list) = history.get("History").and_then(|v| v.as_array()) else {
            continue;
        };
        for entry in list.iter().take(PARTY_INFER_MATCHES) {
            let Some(id) = entry.get("MatchID").and_then(|v| v.as_str()) else {
                continue;
            };
            if seen.insert(id.to_string()) {
                match_ids.push(id.to_string());
                if match_ids.len() >= PARTY_INFER_MAX_DETAILS {
                    break;
                }
            }
        }
        if match_ids.len() >= PARTY_INFER_MAX_DETAILS {
            break;
        }
    }

    let mut counts: HashMap<(String, String), u32> = HashMap::new();
    for id in match_ids {
        let url = format!("https://pd.{shard}.a.pvp.net/match-details/v1/matches/{id}");
        if let Ok(resp) = client.get(&url).headers(headers.clone()).send().await {
            if resp.status().is_success() {
                if let Ok(detail) = resp.json::<Value>().await {
                    count_party_pairs(&detail, &roster, &mut counts);
                }
            }
        }
        // Keep the detail burst polite; this runs off the UI path anyway.
        tokio::time::sleep(Duration::from_millis(60)).await;
    }

    group_by_pair_counts(puuids, &counts)
}

/// Exact presence ids win over own-party knowledge, which wins over history
/// inference. Groups that only contain one lobby player are dropped so solo
/// players stay unlabelled.
fn merge_party_tags(
    puuids: &[String],
    presence: &HashMap<String, String>,
    own_party_id: Option<&str>,
    own_members: &HashSet<String>,
    inferred: &HashMap<String, String>,
) -> HashMap<String, PartyTag> {
    let mut tags: HashMap<String, PartyTag> = HashMap::new();
    for puuid in puuids {
        let key = puuid.to_lowercase();
        if let Some(id) = presence.get(&key).filter(|id| !id.is_empty()) {
            tags.insert(
                key,
                PartyTag {
                    id: id.clone(),
                    inferred: false,
                },
            );
        } else if own_members.contains(&key) {
            if let Some(id) = own_party_id.filter(|id| !id.is_empty()) {
                tags.insert(
                    key,
                    PartyTag {
                        id: id.to_string(),
                        inferred: false,
                    },
                );
            }
        } else if let Some(id) = inferred.get(&key) {
            tags.insert(
                key,
                PartyTag {
                    id: id.clone(),
                    inferred: true,
                },
            );
        }
    }

    let mut sizes: HashMap<String, usize> = HashMap::new();
    for tag in tags.values() {
        *sizes.entry(tag.id.clone()).or_insert(0) += 1;
    }
    tags.retain(|_, tag| sizes.get(&tag.id).copied().unwrap_or(0) >= 2);
    tags
}

async fn resolve_match_parties(
    client: &reqwest::Client,
    shard: &str,
    headers: &HeaderMap,
    match_key: &str,
    puuids: &[String],
    own: &PartyMembers,
) -> HashMap<String, PartyTag> {
    if puuids.len() < 2 || match_key.is_empty() {
        return HashMap::new();
    }

    // A new match invalidates both the presence map and the inference.
    if let Ok(mut guard) = party_resolution().lock() {
        if guard.match_key != match_key {
            *guard = PartyResolutionCache {
                match_key: match_key.to_string(),
                ..Default::default()
            };
        }
    }

    let presence_due = party_resolution()
        .lock()
        .map(|guard| {
            guard
                .presence_fetched_at
                .map(|at| at.elapsed() >= PARTY_PRESENCE_TTL)
                .unwrap_or(true)
        })
        .unwrap_or(false);
    if presence_due {
        let presence = fetch_presence_party_map().await;
        if let Ok(mut guard) = party_resolution().lock() {
            if guard.match_key == match_key {
                guard.presence = presence;
                guard.presence_fetched_at = Some(Instant::now());
            }
        }
    }

    let start_inference = if let Ok(mut guard) = party_resolution().lock() {
        let due = guard
            .inference_started_at
            .map(|at| at.elapsed() >= PARTY_INFER_RETRY)
            .unwrap_or(true);
        if guard.match_key == match_key && due {
            guard.inference_started_at = Some(Instant::now());
            true
        } else {
            false
        }
    } else {
        false
    };
    if start_inference {
        let client = client.clone();
        let shard = shard.to_string();
        let headers = headers.clone();
        let puuids = puuids.to_vec();
        let match_key = match_key.to_string();
        tauri::async_runtime::spawn(async move {
            let inferred = infer_parties_from_history(&client, &shard, &headers, &puuids).await;
            if let Ok(mut guard) = party_resolution().lock() {
                if guard.match_key == match_key {
                    guard.inferred = inferred;
                }
            }
        });
    }

    let (presence, inferred) = party_resolution()
        .lock()
        .map(|guard| (guard.presence.clone(), guard.inferred.clone()))
        .unwrap_or_default();

    merge_party_tags(
        puuids,
        &presence,
        own.party_id.as_deref(),
        &own.members,
        &inferred,
    )
}

/// Fills `party_size` from the resolved ids across the roster.
fn fill_party_sizes(players: &mut [LiveMatchPlayerRaw]) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for player in players.iter() {
        if let Some(id) = &player.party_id {
            *counts.entry(id.clone()).or_insert(0) += 1;
        }
    }
    for player in players.iter_mut() {
        player.party_size = player
            .party_id
            .as_ref()
            .and_then(|id| counts.get(id))
            .copied()
            .unwrap_or(1);
    }
}

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
    let member_set: HashSet<String> = puuids.iter().map(|p| p.to_lowercase()).collect();
    if let Ok(mut guard) = last_party().lock() {
        *guard = PartyMembers {
            party_id: Some(party_id.clone()),
            members: member_set,
            fetched_at: Some(Instant::now()),
        };
    }
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
            party_id: Some(party_id.clone()),
            party_size: 1,
            party_inferred: false,
            is_party_member: true,
        });
    }

    fill_party_sizes(&mut players);

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

/* ---------- Riot cloud API (self-hosted replacement for HenrikDev) ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LivePlayerStatsResponse {
    pub ok: bool,
    pub message: Option<String>,
    pub tier: i64,
    pub rr: i64,
    pub peak_tier: Option<i64>,
    pub peak_season: Option<String>,
    pub wins: Option<i64>,
    pub games: Option<i64>,
    pub kd: Option<f64>,
    pub hs_percent: Option<f64>,
    pub kd_sample: i64,
}

impl LivePlayerStatsResponse {
    fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: Some(message.into()),
            tier: 0,
            rr: 0,
            peak_tier: None,
            peak_season: None,
            wins: None,
            games: None,
            kd: None,
            hs_percent: None,
            kd_sample: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardPlayerDto {
    pub puuid: Option<String>,
    pub game_name: String,
    pub tag_line: String,
    pub rank: i64,
    pub rr: i64,
    pub wins: i64,
    pub tier: i64,
    pub card_id: Option<String>,
    pub title_id: Option<String>,
    pub is_anonymized: bool,
    pub is_banned: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardThresholdDto {
    pub tier: i64,
    pub rr_threshold: i64,
    pub start_index: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaderboardSliceResponse {
    pub ok: bool,
    pub message: Option<String>,
    pub players: Vec<LeaderboardPlayerDto>,
    pub thresholds: Vec<LeaderboardThresholdDto>,
    pub total_players: i64,
    pub start_index: i64,
}

impl LeaderboardSliceResponse {
    fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: Some(message.into()),
            players: Vec::new(),
            thresholds: Vec::new(),
            total_players: 0,
            start_index: 0,
        }
    }
}

struct CloudAuth {
    access_token: String,
    entitlement: String,
    shard: String,
    client_version: String,
}

fn cloud_headers(auth: &CloudAuth) -> HeaderMap {
    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", auth.access_token)) {
        headers.insert(AUTHORIZATION, v);
    }
    if let Ok(v) = HeaderValue::from_str(&auth.entitlement) {
        headers.insert("X-Riot-Entitlements-JWT", v);
    }
    if let Ok(v) = HeaderValue::from_str(&auth.client_version) {
        headers.insert("X-Riot-ClientVersion", v);
    }
    headers.insert(
        "X-Riot-ClientPlatform",
        HeaderValue::from_static(CLIENT_PLATFORM_B64),
    );
    headers
}

/// Prefers the running Riot Client (fresh tokens for any account) and falls
/// back to the Riot account session saved by the shop login.
async fn resolve_cloud_auth(
    local_client: &reqwest::Client,
    remote_client: &reqwest::Client,
    session: Option<&crate::riot_auth::RiotSessionInput>,
    region_fallback: Option<&str>,
) -> Result<CloudAuth, String> {
    let log_info = scan_shooter_game_log();
    let (_glz, fb_shard) = fallback_glz_and_shard(region_fallback.unwrap_or("ap"));
    let shard = log_info.shard.clone().unwrap_or(fb_shard);

    let mut tokens: Option<(String, String)> = None;
    if let Some(lock) = read_lockfile() {
        let basic = BASE64.encode(format!("riot:{}", lock.password));
        let url = format!("https://127.0.0.1:{}/entitlements/v1/token", lock.port);
        if let Ok(resp) = local_client
            .get(&url)
            .header(AUTHORIZATION, format!("Basic {basic}"))
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(data) = resp.json::<EntitlementsTokenResp>().await {
                    if !data.access_token.is_empty() {
                        tokens = Some((data.access_token, data.token));
                    }
                }
            }
        }
    }

    if tokens.is_none() {
        if let Some(session) = session {
            if !session.access_token.is_empty() {
                let entitlement =
                    crate::riot_auth::fetch_entitlements(remote_client, &session.access_token)
                        .await
                        .unwrap_or_else(|_| session.entitlements.clone());
                tokens = Some((session.access_token.clone(), entitlement));
            }
        }
    }

    let Some((access_token, entitlement)) = tokens else {
        return Err(
            "VALORANT（Riot Client）を起動するか、ショップ画面からRiotアカウントにログインしてください。"
                .to_string(),
        );
    };

    let client_version = resolve_client_version(remote_client, log_info.client_version).await;
    Ok(CloudAuth {
        access_token,
        entitlement,
        shard,
        client_version,
    })
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

fn iso_now_utc() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[derive(Clone)]
struct SeasonsInfo {
    current_act_id: Option<String>,
    names: HashMap<String, String>,
}

static SEASONS_CACHE: OnceLock<Mutex<Option<(SeasonsInfo, Instant)>>> = OnceLock::new();

fn seasons_cache() -> &'static Mutex<Option<(SeasonsInfo, Instant)>> {
    SEASONS_CACHE.get_or_init(|| Mutex::new(None))
}

/// Current act UUID plus a UUID → act name map, read from valorant-api.com.
async fn load_seasons(client: &reqwest::Client) -> Option<SeasonsInfo> {
    if let Ok(guard) = seasons_cache().lock() {
        if let Some((info, at)) = guard.as_ref() {
            if at.elapsed() < Duration::from_secs(3600) {
                return Some(info.clone());
            }
        }
    }

    let json = client
        .get("https://valorant-api.com/v1/seasons")
        .send()
        .await
        .ok()?
        .json::<Value>()
        .await
        .ok()?;
    let acts = json.get("data")?.as_array()?;
    let now = iso_now_utc();
    let mut current: Option<(String, String)> = None;
    let mut names = HashMap::new();

    for act in acts {
        if act.get("type").and_then(|v| v.as_str()) != Some("EAresSeasonType::Act") {
            continue;
        }
        let Some(uuid) = act.get("uuid").and_then(|v| v.as_str()) else {
            continue;
        };
        if let Some(name) = act.get("displayName").and_then(|v| v.as_str()) {
            names.insert(uuid.to_string(), name.to_string());
        }
        let start = act
            .get("startTime")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !start.is_empty() && start <= now.as_str() {
            let newer = current
                .as_ref()
                .map(|(best, _)| start > best.as_str())
                .unwrap_or(true);
            if newer {
                current = Some((start.to_string(), uuid.to_string()));
            }
        }
    }

    let info = SeasonsInfo {
        current_act_id: current.map(|(_, id)| id),
        names,
    };
    if let Ok(mut guard) = seasons_cache().lock() {
        *guard = Some((info.clone(), Instant::now()));
    }
    Some(info)
}

const LIVE_STATS_TTL: Duration = Duration::from_secs(600);

static LIVE_STATS_CACHE: OnceLock<Mutex<HashMap<String, (LivePlayerStatsResponse, Instant)>>> =
    OnceLock::new();

fn live_stats_cache() -> &'static Mutex<HashMap<String, (LivePlayerStatsResponse, Instant)>> {
    LIVE_STATS_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn fetch_kd_stats(
    client: &reqwest::Client,
    pd: &str,
    headers: &HeaderMap,
    puuid: &str,
) -> (Option<f64>, Option<f64>, i64) {
    let history_url = format!(
        "{pd}/match-history/v1/history/{puuid}?startIndex=0&endIndex=10"
    );
    let Ok(resp) = client
        .get(&history_url)
        .headers(headers.clone())
        .send()
        .await
    else {
        return (None, None, 0);
    };
    if !resp.status().is_success() {
        return (None, None, 0);
    }
    let Ok(history) = resp.json::<Value>().await else {
        return (None, None, 0);
    };
    let match_ids: Vec<String> = history
        .get("History")
        .and_then(|v| v.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter(|m| {
                    m.get("QueueID").and_then(|v| v.as_str()) == Some("competitive")
                })
                .filter_map(|m| m.get("MatchID").and_then(|v| v.as_str()).map(String::from))
                .take(3)
                .collect()
        })
        .unwrap_or_default();

    let mut kills = 0i64;
    let mut deaths = 0i64;
    let mut head = 0i64;
    let mut shots = 0i64;
    let mut sample = 0i64;

    for match_id in match_ids {
        let url = format!("{pd}/match-details/v1/matches/{match_id}");
        let Ok(resp) = client.get(&url).headers(headers.clone()).send().await else {
            continue;
        };
        if !resp.status().is_success() {
            continue;
        }
        let Ok(details) = resp.json::<Value>().await else {
            continue;
        };
        let Some(players) = details.get("players").and_then(|v| v.as_array()) else {
            continue;
        };
        for player in players {
            let subject = player.get("subject").and_then(|v| v.as_str()).unwrap_or("");
            if !subject.eq_ignore_ascii_case(puuid) {
                continue;
            }
            let stats = player.get("stats");
            let k = stats
                .and_then(|s| s.get("kills"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let d = stats
                .and_then(|s| s.get("deaths"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let h = stats
                .and_then(|s| s.get("headshots"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let b = stats
                .and_then(|s| s.get("bodyshots"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let l = stats
                .and_then(|s| s.get("legshots"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            kills += k;
            deaths += d;
            head += h;
            shots += h + b + l;
            sample += 1;
            break;
        }
    }

    if sample == 0 {
        return (None, None, 0);
    }
    let kd = if deaths > 0 {
        (kills as f64 / deaths as f64 * 100.0).round() / 100.0
    } else {
        kills as f64
    };
    let hs = if shots > 0 {
        ((head as f64 / shots as f64) * 1000.0).round() / 10.0
    } else {
        return (Some(kd), None, sample);
    };
    (Some(kd), Some(hs), sample)
}

#[tauri::command]
pub async fn fetch_live_player_stats(
    puuid: String,
    region_fallback: Option<String>,
    session: Option<crate::riot_auth::RiotSessionInput>,
) -> Result<LivePlayerStatsResponse, String> {
    let puuid = puuid.trim().to_string();
    if puuid.is_empty() {
        return Ok(LivePlayerStatsResponse::error("プレイヤーIDが空です。"));
    }
    let key = puuid.to_lowercase();
    if let Ok(guard) = live_stats_cache().lock() {
        if let Some((cached, at)) = guard.get(&key) {
            if at.elapsed() < LIVE_STATS_TTL {
                return Ok(cached.clone());
            }
        }
    }

    let local_client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| format!("ローカルHTTPクライアント初期化エラー: {e}"))?;
    let remote_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("HTTPクライアント初期化エラー: {e}"))?;

    let auth = match resolve_cloud_auth(
        &local_client,
        &remote_client,
        session.as_ref(),
        region_fallback.as_deref(),
    )
    .await
    {
        Ok(auth) => auth,
        Err(message) => return Ok(LivePlayerStatsResponse::error(message)),
    };
    let headers = cloud_headers(&auth);
    let pd = format!("https://pd.{}.a.pvp.net", auth.shard);

    let mut response = LivePlayerStatsResponse::error("プレイヤー統計を取得できませんでした。");
    response.ok = true;
    response.message = None;

    let mmr_url = format!("{pd}/mmr/v1/players/{puuid}");
    if let Ok(resp) = remote_client
        .get(&mmr_url)
        .headers(headers.clone())
        .send()
        .await
    {
        if resp.status().is_success() {
            if let Ok(mmr) = resp.json::<Value>().await {
                let seasons = mmr.pointer("/QueueSkills/competitive/SeasonalInfoBySeasonID");
                let seasons_info = load_seasons(&remote_client).await;
                let latest_season = mmr
                    .pointer("/LatestCompetitiveUpdate/SeasonID")
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let season_key = seasons_info
                    .as_ref()
                    .and_then(|s| s.current_act_id.clone())
                    .or(latest_season);

                if let (Some(seasons), Some(season_key)) = (seasons, season_key) {
                    if let Some(current) = seasons.get(&season_key) {
                        response.tier = current
                            .get("CompetitiveTier")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0);
                        response.rr = current
                            .get("RankedRating")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0);
                        response.wins = current
                            .get("NumberOfWins")
                            .and_then(|v| v.as_i64());
                        response.games = current
                            .get("NumberOfGames")
                            .and_then(|v| v.as_i64());
                    }
                }

                if let Some(map) = seasons.and_then(|v| v.as_object()) {
                    let mut peak = 0i64;
                    let mut peak_key: Option<&String> = None;
                    for (season, info) in map {
                        let tier = info
                            .get("CompetitiveTier")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0);
                        if tier > peak {
                            peak = tier;
                            peak_key = Some(season);
                        }
                    }
                    if peak > 0 {
                        response.peak_tier = Some(peak);
                        response.peak_season = peak_key.and_then(|k| {
                            seasons_info
                                .as_ref()
                                .and_then(|s| s.names.get(k).cloned())
                        });
                    }
                }
            }
        }
    }

    let (kd, hs, sample) = fetch_kd_stats(&remote_client, &pd, &headers, &puuid).await;
    response.kd = kd;
    response.hs_percent = hs;
    response.kd_sample = sample;

    if let Ok(mut guard) = live_stats_cache().lock() {
        guard.insert(key, (response.clone(), Instant::now()));
    }
    Ok(response)
}

const LEADERBOARD_TTL: Duration = Duration::from_secs(300);

static LEADERBOARD_CACHE: OnceLock<
    Mutex<HashMap<String, (LeaderboardSliceResponse, Instant)>>,
> = OnceLock::new();

fn leaderboard_cache() -> &'static Mutex<HashMap<String, (LeaderboardSliceResponse, Instant)>> {
    LEADERBOARD_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn fetch_leaderboard_slice(
    region: String,
    start_index: Option<i64>,
    size: Option<i64>,
    query: Option<String>,
    session: Option<crate::riot_auth::RiotSessionInput>,
) -> Result<LeaderboardSliceResponse, String> {
    let region = region.trim().to_lowercase();
    if region.is_empty() {
        return Ok(LeaderboardSliceResponse::error("リージョンが指定されていません。"));
    }
    let start = start_index.unwrap_or(0).max(0);
    let size = size.unwrap_or(100).clamp(1, 1000);
    let query = query.unwrap_or_default().trim().to_string();
    let key = format!("{region}:{start}:{size}:{}", query.to_lowercase());

    if let Ok(guard) = leaderboard_cache().lock() {
        if let Some((cached, at)) = guard.get(&key) {
            if at.elapsed() < LEADERBOARD_TTL {
                return Ok(cached.clone());
            }
        }
    }

    let local_client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| format!("ローカルHTTPクライアント初期化エラー: {e}"))?;
    let remote_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTPクライアント初期化エラー: {e}"))?;

    let auth = match resolve_cloud_auth(
        &local_client,
        &remote_client,
        session.as_ref(),
        Some(&region),
    )
    .await
    {
        Ok(auth) => auth,
        Err(message) => return Ok(LeaderboardSliceResponse::error(message)),
    };

    let Some(seasons) = load_seasons(&remote_client).await else {
        return Ok(LeaderboardSliceResponse::error(
            "現在のシーズン情報を取得できませんでした。",
        ));
    };
    let Some(act_id) = seasons.current_act_id else {
        return Ok(LeaderboardSliceResponse::error(
            "現在のシーズンIDを特定できませんでした。",
        ));
    };

    let (_glz, shard) = fallback_glz_and_shard(&region);
    let affinity = shard;
    let base = format!(
        "https://pd.{}.a.pvp.net/mmr/v1/leaderboards/affinity/{affinity}/queue/competitive",
        auth.shard
    );
    let mut query_suffix = format!("?startIndex={start}&size={size}");
    if !query.is_empty() {
        query_suffix.push_str(&format!("&query={}", urlencoding(&query)));
    }

    // Current clients use `season/{act}`; older builds only accept `act/{act}`.
    let mut resp = remote_client
        .get(format!("{base}/season/{act_id}{query_suffix}"))
        .headers(cloud_headers(&auth))
        .send()
        .await;
    if let Ok(r) = &resp {
        if r.status().as_u16() == 400 || r.status().as_u16() == 404 {
            resp = remote_client
                .get(format!("{base}/act/{act_id}{query_suffix}"))
                .headers(cloud_headers(&auth))
                .send()
                .await;
        }
    }
    let resp = match resp {
        Ok(resp) => resp,
        Err(e) => {
            return Ok(LeaderboardSliceResponse::error(format!(
                "リーダーボードの取得に失敗しました: {e}"
            )));
        }
    };

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let message = if code == 401 || code == 403 {
            "認証に失敗しました。VALORANT を起動し直すか、ショップ画面から再ログインしてください。".to_string()
        } else {
            format!("リーダーボードの取得に失敗しました (HTTP {code})。")
        };
        return Ok(LeaderboardSliceResponse::error(message));
    }

    let json = match resp.json::<Value>().await {
        Ok(json) => json,
        Err(e) => {
            return Ok(LeaderboardSliceResponse::error(format!(
                "リーダーボードの解析に失敗しました: {e}"
            )));
        }
    };

    let players = json
        .get("Players")
        .and_then(|v| v.as_array())
        .map(|entries| {
            entries
                .iter()
                .map(|p| LeaderboardPlayerDto {
                    puuid: p
                        .get("puuid")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_lowercase()),
                    game_name: p
                        .get("gameName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    tag_line: p
                        .get("tagLine")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    rank: p
                        .get("leaderboardRank")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    rr: p.get("rankedRating").and_then(|v| v.as_i64()).unwrap_or(0),
                    wins: p
                        .get("numberOfWins")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    tier: p
                        .get("competitiveTier")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0),
                    card_id: p
                        .get("PlayerCardID")
                        .and_then(|v| v.as_str())
                        .filter(|v| !is_zero_guid(v))
                        .map(String::from),
                    title_id: p
                        .get("TitleID")
                        .and_then(|v| v.as_str())
                        .filter(|v| !is_zero_guid(v))
                        .map(String::from),
                    is_anonymized: p
                        .get("IsAnonymized")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    is_banned: p
                        .get("IsBanned")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut thresholds: Vec<LeaderboardThresholdDto> = json
        .get("tierDetails")
        .and_then(|v| v.as_object())
        .map(|details| {
            details
                .iter()
                .filter_map(|(tier, detail)| {
                    let tier = tier.parse::<i64>().ok()?;
                    Some(LeaderboardThresholdDto {
                        tier,
                        rr_threshold: detail
                            .get("rankedRatingThreshold")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0),
                        start_index: detail
                            .get("startingIndex")
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    thresholds.sort_by(|a, b| b.tier.cmp(&a.tier));

    let response = LeaderboardSliceResponse {
        ok: true,
        message: None,
        players,
        thresholds,
        total_players: json
            .get("totalPlayers")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        start_index: json
            .get("startIndex")
            .and_then(|v| v.as_i64())
            .unwrap_or(start),
    };

    if let Ok(mut guard) = leaderboard_cache().lock() {
        guard.insert(key, (response.clone(), Instant::now()));
    }
    Ok(response)
}

fn urlencoding(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/* ---------- Match loadouts (all players, pregame / current game) ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchLoadoutItemDto {
    pub id: String,
    pub type_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchLoadoutWeaponDto {
    pub weapon_id: String,
    pub items: Vec<MatchLoadoutItemDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchLoadoutPlayerDto {
    pub puuid: String,
    pub weapons: Vec<MatchLoadoutWeaponDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchLoadoutsResponse {
    pub ok: bool,
    pub message: Option<String>,
    pub players: Vec<MatchLoadoutPlayerDto>,
}

impl MatchLoadoutsResponse {
    fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: Some(message.into()),
            players: Vec::new(),
        }
    }
}

static MATCH_LOADOUT_CACHE: OnceLock<
    Mutex<HashMap<String, (MatchLoadoutsResponse, Instant)>>,
> = OnceLock::new();

fn match_loadout_cache() -> &'static Mutex<HashMap<String, (MatchLoadoutsResponse, Instant)>> {
    MATCH_LOADOUT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Equipped skins for every player in the current match. The per-player
/// `personalization` endpoint only answers for your own PUUID, so this is the
/// only way to show teammates'/enemies' lockers.
#[tauri::command]
pub async fn fetch_match_loadouts(
    match_id: String,
    phase: Option<String>,
    region_fallback: Option<String>,
    session: Option<crate::riot_auth::RiotSessionInput>,
) -> Result<MatchLoadoutsResponse, String> {
    let match_id = match_id.trim().to_string();
    if match_id.is_empty() {
        return Ok(MatchLoadoutsResponse::error("試合IDが空です。"));
    }
    if let Ok(guard) = match_loadout_cache().lock() {
        if let Some((cached, at)) = guard.get(&match_id) {
            if at.elapsed() < Duration::from_secs(300) {
                return Ok(cached.clone());
            }
        }
    }

    let local_client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| format!("ローカルHTTPクライアント初期化エラー: {e}"))?;
    let remote_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("HTTPクライアント初期化エラー: {e}"))?;

    let auth = match resolve_cloud_auth(
        &local_client,
        &remote_client,
        session.as_ref(),
        region_fallback.as_deref(),
    )
    .await
    {
        Ok(auth) => auth,
        Err(message) => return Ok(MatchLoadoutsResponse::error(message)),
    };

    let log_info = scan_shooter_game_log();
    let (fb_glz, _) = fallback_glz_and_shard(region_fallback.as_deref().unwrap_or("ap"));
    let glz_region = log_info.glz_region.unwrap_or(fb_glz);
    let is_pregame = phase
        .as_deref()
        .map(|p| p.eq_ignore_ascii_case("PREGAME"))
        .unwrap_or(false);
    let path = if is_pregame { "pregame" } else { "core-game" };
    let url = format!(
        "https://glz-{glz_region}-1.{}.a.pvp.net/{path}/v1/matches/{match_id}/loadouts",
        auth.shard
    );

    let resp = match remote_client
        .get(&url)
        .headers(cloud_headers(&auth))
        .send()
        .await
    {
        Ok(resp) => resp,
        Err(e) => {
            return Ok(MatchLoadoutsResponse::error(format!(
                "ロッカーの取得に失敗しました: {e}"
            )));
        }
    };

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let message = if code == 401 || code == 403 {
            "ロッカーを取得できませんでした（認証エラー）。VALORANT を起動し直してください。"
                .to_string()
        } else if code == 404 {
            "この試合のロッカーはまだ取得できません。".to_string()
        } else {
            format!("ロッカーを取得できませんでした (HTTP {code})。")
        };
        return Ok(MatchLoadoutsResponse::error(message));
    }

    let json = match resp.json::<Value>().await {
        Ok(json) => json,
        Err(e) => {
            return Ok(MatchLoadoutsResponse::error(format!(
                "ロッカーの解析に失敗しました: {e}"
            )));
        }
    };

    let mut players = Vec::new();
    if let Some(entries) = json.get("Loadouts").and_then(|v| v.as_array()) {
        for entry in entries {
            // Pregame puts Subject/Items at the top level; core-game nests them
            // under `Loadout`.
            let loadout = entry.get("Loadout").unwrap_or(entry);
            let Some(subject) = loadout.get("Subject").and_then(|v| v.as_str()) else {
                continue;
            };
            let Some(items) = loadout.get("Items").and_then(|v| v.as_object()) else {
                continue;
            };
            let mut weapons = Vec::new();
            for (weapon_id, weapon) in items {
                let mut sockets = Vec::new();
                if let Some(map) = weapon.get("Sockets").and_then(|v| v.as_object()) {
                    for socket in map.values() {
                        if let Some(inner) = socket.get("Item") {
                            let id = inner.get("ID").and_then(|v| v.as_str()).unwrap_or("");
                            let type_id = inner
                                .get("TypeID")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if !id.is_empty() && !is_zero_guid(id) {
                                sockets.push(MatchLoadoutItemDto {
                                    id: id.to_string(),
                                    type_id: type_id.to_string(),
                                });
                            }
                        }
                    }
                }
                if !sockets.is_empty() {
                    weapons.push(MatchLoadoutWeaponDto {
                        weapon_id: weapon_id.clone(),
                        items: sockets,
                    });
                }
            }
            players.push(MatchLoadoutPlayerDto {
                puuid: subject.to_lowercase(),
                weapons,
            });
        }
    }

    let response = MatchLoadoutsResponse {
        ok: true,
        message: None,
        players,
    };
    if let Ok(mut guard) = match_loadout_cache().lock() {
        guard.insert(match_id, (response.clone(), Instant::now()));
    }
    Ok(response)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadoutGunDto {
    /// Weapon UUID (`Guns[].ID`).
    pub weapon_id: String,
    /// Equipped skin level UUID (`Guns[].Skins[0].ID`).
    pub skin_level_id: Option<String>,
    /// Skin UUID (`Guns[].Skins[0].TypeID`).
    pub skin_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerLoadoutResponse {
    pub ok: bool,
    pub message: Option<String>,
    pub guns: Vec<LoadoutGunDto>,
    pub card_id: Option<String>,
    pub title_id: Option<String>,
}

fn loadout_error(message: impl Into<String>) -> PlayerLoadoutResponse {
    PlayerLoadoutResponse {
        ok: false,
        message: Some(message.into()),
        guns: Vec::new(),
        card_id: None,
        title_id: None,
    }
}

const LOADOUT_CACHE_TTL: Duration = Duration::from_secs(300);

struct CachedLoadout {
    response: PlayerLoadoutResponse,
    fetched_at: Instant,
}

static LOADOUT_CACHE: OnceLock<Mutex<HashMap<String, CachedLoadout>>> = OnceLock::new();

fn loadout_cache() -> &'static Mutex<HashMap<String, CachedLoadout>> {
    LOADOUT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Reads another player's equipped skins. The endpoint is keyed by PUUID and
/// is served by the local Riot Client session, so it works for every player in
/// the current match (including incognito ones).
#[tauri::command]
pub async fn fetch_player_loadout(
    puuid: String,
    region_fallback: Option<String>,
) -> Result<PlayerLoadoutResponse, String> {
    let puuid = puuid.trim().to_string();
    let key = puuid.to_lowercase();
    if key.is_empty() {
        return Ok(loadout_error("プレイヤーIDが空です。"));
    }

    if let Ok(guard) = loadout_cache().lock() {
        if let Some(entry) = guard.get(&key) {
            if entry.fetched_at.elapsed() < LOADOUT_CACHE_TTL {
                return Ok(entry.response.clone());
            }
        }
    }

    let Some(lock) = read_lockfile() else {
        return Ok(loadout_error(
            "VALORANT（Riot Client）が起動していません。ゲームを起動してから再試行してください。",
        ));
    };

    let local_client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| format!("ローカルHTTPクライアント初期化エラー: {e}"))?;
    let remote_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTPクライアント初期化エラー: {e}"))?;

    let basic = BASE64.encode(format!("riot:{}", lock.password));
    let token_url = format!("https://127.0.0.1:{}/entitlements/v1/token", lock.port);
    let token_resp = match local_client
        .get(&token_url)
        .header(AUTHORIZATION, format!("Basic {basic}"))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.json::<EntitlementsTokenResp>().await {
            Ok(data) => data,
            Err(_) => {
                return Ok(loadout_error(
                    "Riot Client の認証情報を解析できませんでした。",
                ));
            }
        },
        _ => {
            return Ok(loadout_error(
                "Riot Client にログインしていません。VALORANT を起動してから再試行してください。",
            ));
        }
    };

    let log_info = scan_shooter_game_log();
    let (_glz, fb_shard) = fallback_glz_and_shard(region_fallback.as_deref().unwrap_or("ap"));
    let shard = log_info.shard.unwrap_or(fb_shard);
    let client_version = resolve_client_version(&remote_client, log_info.client_version).await;

    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", token_resp.access_token)) {
        headers.insert(AUTHORIZATION, v);
    }
    if let Ok(v) = HeaderValue::from_str(&token_resp.token) {
        headers.insert("X-Riot-Entitlements-JWT", v);
    }
    if let Ok(v) = HeaderValue::from_str(&client_version) {
        headers.insert("X-Riot-ClientVersion", v);
    }
    headers.insert(
        "X-Riot-ClientPlatform",
        HeaderValue::from_static(CLIENT_PLATFORM_B64),
    );

    let url = format!(
        "https://pd.{shard}.a.pvp.net/personalization/v3/players/{puuid}/playerloadout"
    );
    let resp = match remote_client.get(&url).headers(headers).send().await {
        Ok(resp) => resp,
        Err(e) => {
            return Ok(loadout_error(format!(
                "ロッカーの取得に失敗しました: {e}"
            )));
        }
    };

    if !resp.status().is_success() {
        let code = resp.status().as_u16();
        let message = if code == 401 || code == 403 {
            "ロッカーを取得できませんでした（認証エラー）。VALORANT を起動し直してください。"
        } else if code == 404 {
            "このプレイヤーのロッカーは取得できませんでした。"
        } else {
            return Ok(loadout_error(format!(
                "ロッカーを取得できませんでした (HTTP {code})。"
            )));
        };
        return Ok(loadout_error(message));
    }

    let json = resp
        .json::<Value>()
        .await
        .map_err(|e| format!("ロッカーの解析に失敗しました: {e}"))?;

    let guns = json
        .get("Guns")
        .and_then(|v| v.as_array())
        .map(|entries| {
            entries
                .iter()
                .filter_map(|gun| {
                    let weapon_id = gun.get("ID").and_then(|v| v.as_str())?.to_string();
                    let first_skin = gun
                        .get("Skins")
                        .and_then(|v| v.as_array())
                        .and_then(|skins| skins.first());
                    let skin_level_id = first_skin
                        .and_then(|s| s.get("ID"))
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    let skin_id = first_skin
                        .and_then(|s| s.get("TypeID"))
                        .and_then(|v| v.as_str())
                        .map(String::from);
                    Some(LoadoutGunDto {
                        weapon_id,
                        skin_level_id,
                        skin_id,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let card_id = json
        .pointer("/Identity/PlayerCardID")
        .and_then(|v| v.as_str())
        .filter(|v| !is_zero_guid(v))
        .map(String::from);
    let title_id = json
        .pointer("/Identity/PlayerTitleID")
        .and_then(|v| v.as_str())
        .filter(|v| !is_zero_guid(v))
        .map(String::from);

    let response = PlayerLoadoutResponse {
        ok: true,
        message: None,
        guns,
        card_id,
        title_id,
    };
    if let Ok(mut guard) = loadout_cache().lock() {
        guard.insert(
            key,
            CachedLoadout {
                response: response.clone(),
                fetched_at: Instant::now(),
            },
        );
    }
    Ok(response)
}

/* ---------- Fast agent-select picks poll ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PregamePickDto {
    pub puuid: String,
    pub agent_id: String,
    pub selection_state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PregamePicksResponse {
    pub ok: bool,
    pub message: Option<String>,
    pub match_id: Option<String>,
    /// Enemy lock progress from the pregame document. Riot often hides the
    /// enemy agents themselves, but these counters still update live.
    pub enemy_locked: i64,
    pub enemy_size: i64,
    pub picks: Vec<PregamePickDto>,
}

impl PregamePicksResponse {
    fn error(message: impl Into<String>) -> Self {
        Self {
            ok: false,
            message: Some(message.into()),
            match_id: None,
            enemy_locked: 0,
            enemy_size: 0,
            picks: Vec::new(),
        }
    }
}

/// Lightweight agent-select refresh: only the pregame match document, so the
/// UI can poll every second without redoing name/party/rank resolution.
#[tauri::command]
pub async fn fetch_pregame_picks(
    region_fallback: Option<String>,
) -> Result<PregamePicksResponse, String> {
    let Some(lock) = read_lockfile() else {
        return Ok(PregamePicksResponse::error(
            "VALORANT（Riot Client）が起動していません。",
        ));
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

    let basic = BASE64.encode(format!("riot:{}", lock.password));
    let token_url = format!("https://127.0.0.1:{}/entitlements/v1/token", lock.port);
    let token = match local_client
        .get(&token_url)
        .header(AUTHORIZATION, format!("Basic {basic}"))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.json::<EntitlementsTokenResp>().await {
            Ok(data) => data,
            Err(_) => {
                return Ok(PregamePicksResponse::error(
                    "Riot Client の認証情報を解析できませんでした。",
                ));
            }
        },
        _ => {
            return Ok(PregamePicksResponse::error(
                "Riot Client にログインしていません。",
            ));
        }
    };

    let log_info = scan_shooter_game_log();
    let (fb_glz, fb_shard) =
        fallback_glz_and_shard(region_fallback.as_deref().unwrap_or("ap"));
    let glz_region = log_info.glz_region.unwrap_or(fb_glz);
    let shard = log_info.shard.unwrap_or(fb_shard);
    let client_version = resolve_client_version(&remote_client, log_info.client_version).await;

    let mut headers = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {}", token.access_token)) {
        headers.insert(AUTHORIZATION, v);
    }
    if let Ok(v) = HeaderValue::from_str(&token.token) {
        headers.insert("X-Riot-Entitlements-JWT", v);
    }
    if let Ok(v) = HeaderValue::from_str(&client_version) {
        headers.insert("X-Riot-ClientVersion", v);
    }
    headers.insert(
        "X-Riot-ClientPlatform",
        HeaderValue::from_static(CLIENT_PLATFORM_B64),
    );

    let glz_base = format!("https://glz-{glz_region}-1.{shard}.a.pvp.net");
    let player_url = format!("{glz_base}/pregame/v1/players/{}", token.subject);
    let match_id = match remote_client
        .get(&player_url)
        .headers(headers.clone())
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.json::<PlayerMatchResp>().await {
            Ok(p) => p.match_id.unwrap_or_default(),
            Err(_) => String::new(),
        },
        _ => String::new(),
    };
    if match_id.is_empty() {
        return Ok(PregamePicksResponse::error(
            "エージェント選択中ではありません。",
        ));
    }

    let match_url = format!("{glz_base}/pregame/v1/matches/{match_id}");
    let json = match remote_client
        .get(&match_url)
        .headers(headers.clone())
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => match r.json::<Value>().await {
            Ok(v) => v,
            Err(e) => {
                return Ok(PregamePicksResponse::error(format!(
                    "ピック情報の解析に失敗しました: {e}"
                )));
            }
        },
        _ => {
            return Ok(PregamePicksResponse::error(
                "ピック情報を取得できませんでした。",
            ));
        }
    };

    let mut entries: Vec<(String, Value)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();

    if let Some(teams) = json.get("Teams").and_then(|v| v.as_array()) {
        for team in teams {
            if let Some(list) = team.get("Players").and_then(|v| v.as_array()) {
                merge_pregame_entries(&mut entries, &mut index, "", list);
            }
        }
    }
    for key in ["AllyTeam", "EnemyTeam"] {
        if let Some(list) = json
            .get(key)
            .and_then(|v| v.get("Players"))
            .and_then(|v| v.as_array())
        {
            merge_pregame_entries(&mut entries, &mut index, "", list);
        }
    }

    let picks: Vec<PregamePickDto> = entries
        .into_iter()
        .filter_map(|(_, p)| {
            let subject = p.get("Subject").and_then(|v| v.as_str())?.to_lowercase();
            if subject.is_empty() {
                return None;
            }
            Some(PregamePickDto {
                puuid: subject,
                agent_id: p
                    .get("CharacterID")
                    .and_then(|v| v.as_str())
                    .filter(|v| !is_zero_guid(v))
                    .unwrap_or("")
                    .to_string(),
                selection_state: p
                    .get("CharacterSelectionState")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect();

    let enemy_locked = json
        .get("EnemyTeamLockCount")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let enemy_size = json
        .get("EnemyTeamSize")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    Ok(PregamePicksResponse {
        ok: true,
        message: None,
        match_id: Some(match_id),
        enemy_locked,
        enemy_size,
        picks,
    })
}

#[tauri::command]
pub async fn fetch_live_match(
    region_fallback: String,
    api_key: Option<String>,
) -> Result<LiveMatchResponse, String> {
    // Used by the name resolver when the local sources cannot reveal an
    // incognito player (see `resolve_names`).
    if let Ok(mut guard) = HENRIK_KEY.get_or_init(|| Mutex::new(None)).lock() {
        *guard = api_key
            .map(|key| key.trim().to_string())
            .filter(|key| !key.is_empty());
    }
    if let Ok(mut guard) = HENRIK_REGION.get_or_init(|| Mutex::new(String::new())).lock() {
        *guard = region_fallback.trim().to_lowercase();
    }

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

    let glz_base = format!("https://glz-{glz_region}-1.{shard}.a.pvp.net");
    let party = fetch_party_members(remote_client, &glz_base, headers, self_puuid).await;
    let party_tags =
        resolve_match_parties(remote_client, shard, headers, match_id, &puuids, &party).await;
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
        let is_party_member = party.members.contains(&puuid.to_lowercase());
        let party_tag = party_tags.get(&puuid.to_lowercase());

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
            party_id: party_tag.map(|tag| tag.id.clone()),
            party_size: 1,
            party_inferred: party_tag.map(|tag| tag.inferred).unwrap_or(false),
            is_party_member,
        });
    }

    fill_party_sizes(&mut players);

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

fn pregame_player_score(player: &Value) -> (bool, u8) {
    let agent = player
        .get("CharacterID")
        .and_then(|v| v.as_str())
        .filter(|v| !is_zero_guid(v))
        .unwrap_or("");
    let state = player
        .get("CharacterSelectionState")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let rank = match state {
        "locked" => 2,
        "selected" => 1,
        _ => 0,
    };
    (!agent.is_empty(), rank)
}

fn pregame_team_members(match_data: &Value, team_key: &str) -> HashSet<String> {
    match_data
        .get(team_key)
        .and_then(|team| team.get("Players"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|player| {
            player
                .get("Subject")
                .and_then(Value::as_str)
                .map(str::to_lowercase)
        })
        .collect()
}

fn pregame_player_is_ally(
    puuid: &str,
    is_self: bool,
    team_id: &str,
    self_team: &str,
    ally_members: &HashSet<String>,
    enemy_members: &HashSet<String>,
) -> bool {
    let puuid = puuid.to_lowercase();
    if is_self || ally_members.contains(&puuid) {
        return true;
    }
    if enemy_members.contains(&puuid) {
        return false;
    }
    !self_team.is_empty() && team_id.eq_ignore_ascii_case(self_team)
}

/// Merges a team's players into `entries`. Riot can split the roster between
/// `Teams` and `AllyTeam`/`EnemyTeam`; the enemy agent is often only filled in
/// `EnemyTeam`, so a masked copy must not overwrite a revealed one.
fn merge_pregame_entries(
    entries: &mut Vec<(String, Value)>,
    index: &mut HashMap<String, usize>,
    tid: &str,
    players: &[Value],
) {
    for p in players {
        let sub = p
            .get("Subject")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        if sub.is_empty() {
            continue;
        }
        if let Some(&i) = index.get(&sub) {
            if pregame_player_score(p) > pregame_player_score(&entries[i].1) {
                entries[i].1 = p.clone();
            }
            continue;
        }
        index.insert(sub, entries.len());
        entries.push((tid.to_string(), p.clone()));
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
    let mut index_by_puuid: HashMap<String, usize> = HashMap::new();
    let mut push_team = |tid: &str, team: &Value| {
        if let Some(plist) = team.get("Players").and_then(|v| v.as_array()) {
            merge_pregame_entries(&mut team_entries, &mut index_by_puuid, tid, plist);
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

    // These named rosters are authoritative even when Riot omits TeamID from
    // EnemyTeam. Falling back to "Blue" for such entries made enemies appear
    // in the ally column whenever the local team was Blue.
    let ally_members = pregame_team_members(mjson, "AllyTeam");
    let enemy_members = pregame_team_members(mjson, "EnemyTeam");

    let puuids: Vec<String> = team_entries
        .iter()
        .filter_map(|(_, p)| p.get("Subject").and_then(|v| v.as_str()).map(String::from))
        .collect();

    let glz_base = format!("https://glz-{glz_region}-1.{shard}.a.pvp.net");
    let party = fetch_party_members(remote_client, &glz_base, headers, self_puuid).await;
    let party_tags =
        resolve_match_parties(remote_client, shard, headers, match_id, &puuids, &party).await;
    let name_map = resolve_names(remote_client, shard, headers, &puuids).await;

    let mut players = Vec::new();
    for (team_id, p) in &team_entries {
        let puuid = p.get("Subject").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if puuid.is_empty() {
            continue;
        }
        let is_self = puuid.eq_ignore_ascii_case(&self_lower);
        let is_ally = pregame_player_is_ally(
            &puuid,
            is_self,
            team_id,
            &self_team,
            &ally_members,
            &enemy_members,
        );

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
        let is_party_member = party.members.contains(&puuid.to_lowercase());
        let party_tag = party_tags.get(&puuid.to_lowercase());

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
                .filter(|v| !is_zero_guid(v))
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
            party_id: party_tag.map(|tag| tag.id.clone()),
            party_size: 1,
            party_inferred: party_tag.map(|tag| tag.inferred).unwrap_or(false),
            is_party_member,
        });
    }

    fill_party_sizes(&mut players);

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_incognito_placeholder_names() {
        for name in ["Player", "player 3", "Player12", "プレイヤー2", "  "] {
            assert!(is_generic_name(name), "{name} should be generic");
        }
        for name in ["TenZ", "PlayerOne", "Streamer"] {
            assert!(!is_generic_name(name), "{name} should be a real name");
        }
    }

    #[test]
    fn prefers_resolved_name_over_masked_identity() {
        let mut map = HashMap::new();
        map.insert(
            "abc".to_string(),
            ("RealName".to_string(), "JP1".to_string()),
        );
        let payload = serde_json::json!({
            "Subject": "abc",
            "PlayerIdentity": { "GameName": "Player 4", "TagLine": "XXXX" }
        });
        assert_eq!(
            resolve_player_name(&map, "ABC", &payload),
            ("RealName".to_string(), "JP1".to_string())
        );
    }

    #[test]
    fn civil_dates_match_known_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(20_454), (2026, 1, 1));
        assert_eq!(civil_from_days(20_697), (2026, 9, 1));
    }

    #[test]
    fn enemy_team_reveal_overrides_masked_teams_copy() {
        let masked = serde_json::json!({
            "TeamID": "Red",
            "Players": [{ "Subject": "e1", "CharacterID": "", "CharacterSelectionState": "" }]
        });
        let revealed = serde_json::json!({
            "TeamID": "Red",
            "Players": [{ "Subject": "e1", "CharacterID": "agent-1", "CharacterSelectionState": "locked" }]
        });
        let mut entries = Vec::new();
        let mut index = HashMap::new();
        merge_pregame_entries(
            &mut entries,
            &mut index,
            "Red",
            masked["Players"].as_array().unwrap(),
        );
        merge_pregame_entries(
            &mut entries,
            &mut index,
            "Red",
            revealed["Players"].as_array().unwrap(),
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].1["CharacterID"], "agent-1");
        assert_eq!(entries[0].1["CharacterSelectionState"], "locked");
    }

    #[test]
    fn enemy_roster_membership_overrides_a_missing_enemy_team_id() {
        let match_data = serde_json::json!({
            "AllyTeam": {
                "TeamID": "Blue",
                "Players": [{ "Subject": "self" }]
            },
            "EnemyTeam": {
                "Players": [{ "Subject": "ENEMY-1" }]
            }
        });
        let allies = pregame_team_members(&match_data, "AllyTeam");
        let enemies = pregame_team_members(&match_data, "EnemyTeam");

        assert!(pregame_player_is_ally(
            "self", true, "Blue", "Blue", &allies, &enemies
        ));
        // Some pregame payloads omit EnemyTeam.TeamID. Even if a merged copy
        // carries the local team's ID, explicit EnemyTeam membership wins.
        assert!(!pregame_player_is_ally(
            "enemy-1", false, "Blue", "Blue", &allies, &enemies
        ));
    }

    #[test]
    fn zero_guid_agent_counts_as_missing() {
        let zero = serde_json::json!({
            "Subject": "e1",
            "CharacterID": "00000000-0000-0000-0000-000000000000",
            "CharacterSelectionState": ""
        });
        let real = serde_json::json!({
            "Subject": "e1",
            "CharacterID": "agent-1",
            "CharacterSelectionState": "selected"
        });
        assert!(pregame_player_score(&real) > pregame_player_score(&zero));
    }

    #[test]
    fn counts_shared_party_pairs_in_match_details() {
        let detail = serde_json::json!({
            "players": [
                { "subject": "a", "partyId": "p1" },
                { "subject": "b", "partyId": "p1" },
                { "subject": "c", "partyId": "p2" },
                { "subject": "stranger", "partyId": "p1" },
                { "subject": "d", "partyId": "00000000-0000-0000-0000-000000000000" }
            ]
        });
        let roster: HashSet<String> = ["a", "b", "c", "d"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let mut counts = HashMap::new();
        count_party_pairs(&detail, &roster, &mut counts);

        assert_eq!(counts.get(&("a".to_string(), "b".to_string())), Some(&1));
        assert!(counts.keys().all(|(a, b)| a != "d" && b != "d"));
        assert_eq!(counts.len(), 1);
    }

    #[test]
    fn history_inference_needs_two_shared_matches() {
        let puuids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let mut counts = HashMap::new();
        // a and b shared a party twice; c only once with a.
        counts.insert(("a".to_string(), "b".to_string()), 2);
        counts.insert(("a".to_string(), "c".to_string()), 1);

        let groups = group_by_pair_counts(&puuids, &counts);
        assert_eq!(groups.get("a"), Some(&"h:a".to_string()));
        assert_eq!(groups.get("b"), Some(&"h:a".to_string()));
        assert_eq!(groups.get("c"), None);
    }

    #[test]
    fn exact_presence_beats_history_inference() {
        let puuids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let presence = HashMap::from([
            ("a".to_string(), "real-1".to_string()),
            ("b".to_string(), "real-1".to_string()),
        ]);
        let inferred = HashMap::from([
            ("a".to_string(), "h:a".to_string()),
            ("b".to_string(), "h:a".to_string()),
            ("c".to_string(), "h:a".to_string()),
        ]);
        let tags = merge_party_tags(&puuids, &presence, None, &HashSet::new(), &inferred);

        assert_eq!(tags["a"].id, "real-1");
        assert!(!tags["a"].inferred);
        assert_eq!(tags["b"].id, "real-1");
        // c's only inferred partner was overwritten by the exact ids.
        assert!(!tags.contains_key("c"));
    }

    #[test]
    fn merge_keeps_groups_of_two_and_marks_them_inferred() {
        let puuids = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let inferred = HashMap::from([
            ("a".to_string(), "h:a".to_string()),
            ("b".to_string(), "h:a".to_string()),
        ]);
        let tags = merge_party_tags(&puuids, &HashMap::new(), None, &HashSet::new(), &inferred);

        assert_eq!(tags["a"].id, "h:a");
        assert_eq!(tags["b"].id, "h:a");
        assert!(tags["a"].inferred);
        assert!(!tags.contains_key("c"));
    }

    #[test]
    fn parses_presence_party_ids_nested_and_flat() {
        let nested = BASE64.encode(r#"{"partyPresenceData":{"partyId":"party-1"}}"#);
        let flat = BASE64.encode(r#"{"partyId":"party-2"}"#);
        let zero = BASE64.encode(
            r#"{"partyPresenceData":{"partyId":"00000000-0000-0000-0000-000000000000"}}"#,
        );
        let body = serde_json::json!({
            "presences": [
                { "puuid": "AAA", "private": nested },
                { "puuid": "bbb", "private": flat },
                { "puuid": "ccc", "private": zero },
                { "puuid": "ddd", "private": "" }
            ]
        });

        let map = parse_presence_parties(&body);
        assert_eq!(map.get("aaa").map(String::as_str), Some("party-1"));
        assert_eq!(map.get("bbb").map(String::as_str), Some("party-2"));
        assert!(!map.contains_key("ccc"));
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn party_sizes_come_from_resolved_ids() {        let mut players = vec![
            test_player("a", Some("p1"), false),
            test_player("b", Some("p1"), false),
            test_player("c", Some("h:c"), true),
            test_player("d", Some("h:c"), true),
            test_player("e", None, false),
        ];
        fill_party_sizes(&mut players);
        assert_eq!(players[0].party_size, 2);
        assert_eq!(players[1].party_size, 2);
        assert_eq!(players[2].party_size, 2);
        assert!(players[2].party_inferred);
        assert_eq!(players[4].party_size, 1);
    }

    fn test_player(puuid: &str, party_id: Option<&str>, inferred: bool) -> LiveMatchPlayerRaw {
        LiveMatchPlayerRaw {
            puuid: puuid.to_string(),
            game_name: puuid.to_string(),
            tag_line: "TEST".to_string(),
            team_id: "Blue".to_string(),
            is_ally: true,
            is_self: false,
            agent_id: String::new(),
            selection_state: String::new(),
            account_level: 0,
            hide_account_level: false,
            is_incognito: false,
            card_id: String::new(),
            pregame_tier: 0,
            party_ready: None,
            is_party_owner: None,
            party_id: party_id.map(String::from),
            party_size: 1,
            party_inferred: inferred,
            is_party_member: false,
        }
    }
}

import { invoke } from "@tauri-apps/api/core";
import type {
  LiveMatchResponse,
  LivePlayerRankInfo,
  LivePlayerStatsResponse,
  MatchLoadoutsResponse,
  PregamePicksResponse,
  Region,
} from "../types/valorant";
import { getCachedData, setCachedData } from "./storage";
import { loadRiotSession } from "./localClientApi";

const VALID_REGIONS: Region[] = ["ap", "eu", "na", "kr", "latam", "br"];
const LIVE_PLAYER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min per player during match

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function riotSessionPayload() {
  const session = loadRiotSession();
  return session
    ? {
        accessToken: session.accessToken,
        entitlements: session.entitlements,
        puuid: session.puuid,
        region: session.region,
      }
    : null;
}

export function normalizeRegion(raw: string | null | undefined, fallback: Region): Region {
  const clean = (raw ?? "").trim().toLowerCase() as Region;
  return VALID_REGIONS.includes(clean) ? clean : fallback;
}

export function formatLiveModeLabel(modeId?: string | null, queueId?: string | null): string {
  const combined = `${queueId ?? ""} ${modeId ?? ""}`.toLowerCase();
  if (combined.includes("competitive")) return "コンペティティブ";
  if (combined.includes("swiftplay")) return "スイフトプレイ";
  if (combined.includes("spikerush") || combined.includes("quickbomb")) return "スパイクラッシュ";
  if (combined.includes("deathmatch") && !combined.includes("hurm")) return "デスマッチ";
  if (combined.includes("hurm")) return "チームデスマッチ";
  if (combined.includes("ggteam") || combined.includes("escalation")) return "エスカレーション";
  if (combined.includes("premier")) return "プレミア";
  if (combined.includes("custom")) return "カスタム";
  if (combined.includes("unrated") || combined.includes("bomb")) return "アンレート / スタンダード";
  return queueId || "カスタム / その他";
}

export async function fetchLiveMatchFromClient(
  regionFallback: Region,
  apiKey?: string,
): Promise<LiveMatchResponse> {
  if (!isTauriRuntime()) {
    return {
      status: "ERROR",
      message: "試合中のリアルタイム取得はデスクトップアプリ（.exe）でのみ利用可能です。",
      matchId: null,
      mapUrl: null,
      modeId: null,
      queueId: null,
      serverPod: null,
      detectedRegion: null,
      detectedShard: null,
      selfPuuid: null,
      players: [],
    };
  }

  return invoke<LiveMatchResponse>("fetch_live_match", {
    regionFallback,
    apiKey: apiKey?.trim() || null,
  });
}

/**
 * Fast agent-select refresh: only the pregame match document, so the UI can
 * poll every second while both teams pick their agents.
 */
export async function fetchPregamePicks(
  region: Region,
): Promise<PregamePicksResponse> {
  const empty: PregamePicksResponse = {
    ok: false,
    message: null,
    matchId: null,
    picks: [],
  };
  if (!isTauriRuntime()) return empty;
  try {
    return await invoke<PregamePicksResponse>("fetch_pregame_picks", {
      regionFallback: region,
    });
  } catch {
    return empty;
  }
}

/**
 * Rank / K/D / headshot stats straight from Riot's own pd endpoints
 * (`mmr` + `match-history` + `match-details`). This replaces the HenrikDev
 * lookup so live polling no longer hits a third-party rate limit.
 */export async function fetchPlayerRankByPuuid(
  puuid: string,
  region: Region,
): Promise<LivePlayerRankInfo | null> {
  if (!puuid) return null;
  const cacheKey = `live_puuid_stats_v4:${region}:${puuid.toLowerCase()}`;
  const cached = getCachedData<LivePlayerRankInfo>(cacheKey);
  if (cached) return cached;
  if (!isTauriRuntime()) return null;

  try {
    const stats = await invoke<LivePlayerStatsResponse>("fetch_live_player_stats", {
      puuid,
      regionFallback: region,
      session: riotSessionPayload(),
    });
    if (!stats.ok) return null;

    const wins = stats.wins ?? null;
    const games = stats.games ?? null;
    const info: LivePlayerRankInfo = {
      tierId: stats.tier ?? 0,
      tierName: "",
      rr: stats.rr ?? 0,
      peakTierId: stats.peakTier ?? null,
      peakTierName: null,
      peakSeasonShort: stats.peakSeason ?? null,
      seasonWins: wins,
      seasonGames: games,
      seasonWinRate:
        wins !== null && games !== null && games > 0
          ? Number(((wins / games) * 100).toFixed(1))
          : null,
      kd: stats.kd,
      hsPercent: stats.hsPercent,
      kdSampleSize: stats.kdSample ?? 0,
    };

    setCachedData(cacheKey, info, LIVE_PLAYER_CACHE_TTL_MS);
    return info;
  } catch {
    return null;
  }
}

const MATCH_LOADOUT_CACHE_TTL_MS = 5 * 60 * 1000;
const matchLoadoutCache = new Map<
  string,
  { at: number; value: MatchLoadoutsResponse }
>();

/**
 * Equipped skins for every player in the match. The per-player endpoint only
 * answers for your own PUUID, so the match loadouts endpoint is required to
 * show teammates'/enemies' lockers.
 */
export async function fetchMatchLoadouts(
  matchId: string,
  phase: "PREGAME" | "IN_GAME",
  region: Region,
): Promise<MatchLoadoutsResponse> {
  const empty: MatchLoadoutsResponse = { ok: false, message: null, players: [] };
  if (!matchId) {
    return { ...empty, message: "試合IDがありません。" };
  }
  if (!isTauriRuntime()) {
    return {
      ...empty,
      message: "ロッカーの取得はデスクトップアプリ（.exe）でのみ利用可能です。",
    };
  }

  const key = `${matchId}:${phase}`;
  const hit = matchLoadoutCache.get(key);
  if (hit && Date.now() - hit.at < MATCH_LOADOUT_CACHE_TTL_MS) {
    return hit.value;
  }

  try {
    const value = await invoke<MatchLoadoutsResponse>("fetch_match_loadouts", {
      matchId,
      phase,
      regionFallback: region,
      session: riotSessionPayload(),
    });
    if (value.ok) matchLoadoutCache.set(key, { at: Date.now(), value });
    return value;
  } catch (err) {
    return {
      ...empty,
      message:
        err instanceof Error ? err.message : "ロッカーを取得できませんでした。",
    };
  }
}

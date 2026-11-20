import { invoke } from "@tauri-apps/api/core";
import type {
  HenrikMatchesV4Match,
  HenrikMmrV3Data,
  LiveMatchResponse,
  LivePlayerRankInfo,
  Region,
} from "../types/valorant";
import { getCachedData, sanitizeApiKey, setCachedData } from "./storage";

const BASE_URL = "https://api.henrikdev.xyz";
const VALID_REGIONS: Region[] = ["ap", "eu", "na", "kr", "latam", "br"];
const LIVE_PLAYER_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min per player during match

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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

export async function fetchLiveMatchFromClient(regionFallback: Region): Promise<LiveMatchResponse> {
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
  });
}

interface StoredMatchItem {
  stats?: {
    kills?: number;
    deaths?: number;
    assists?: number;
    shots?: {
      head?: number;
      body?: number;
      leg?: number;
    };
  };
}

async function fetchKdStatsByPuuid(
  puuid: string,
  region: Region,
  cleanKey: string,
): Promise<{
  kd: number | null;
  hsPercent: number | null;
  sampleSize: number;
  accountName: string | null;
  accountTag: string | null;
}> {
  // 1. Fast path: stored-matches (up to 20 competitive games, ~3 KB payload)
  try {
    const smRes = await fetch(
      `${BASE_URL}/valorant/v1/by-puuid/stored-matches/${region}/${encodeURIComponent(puuid)}?mode=competitive&size=20`,
      {
        method: "GET",
        headers: {
          Authorization: cleanKey,
          Accept: "application/json",
        },
      },
    );

    if (smRes.ok) {
      const smBody = (await smRes.json()) as { data?: StoredMatchItem[] };
      const items = smBody.data ?? [];
      if (items.length > 0) {
        let kills = 0;
        let deaths = 0;
        let head = 0;
        let totalShots = 0;
        for (const item of items.slice(0, 20)) {
          kills += item.stats?.kills ?? 0;
          deaths += item.stats?.deaths ?? 0;
          const h = item.stats?.shots?.head ?? 0;
          const b = item.stats?.shots?.body ?? 0;
          const l = item.stats?.shots?.leg ?? 0;
          head += h;
          totalShots += h + b + l;
        }
        const sampleSize = Math.min(20, items.length);
        const kd = Number((deaths > 0 ? kills / deaths : kills).toFixed(2));
        const hsPercent =
          totalShots > 0 ? Number(((head / totalShots) * 100).toFixed(1)) : null;
        return { kd, hsPercent, sampleSize, accountName: null, accountTag: null };
      }
    }
  } catch {
    // Fall through to v4 matches fallback
  }

  // 2. Fallback: live v4 matches by PUUID (works even for players never previously indexed)
  try {
    const v4Res = await fetch(
      `${BASE_URL}/valorant/v4/by-puuid/matches/${region}/pc/${encodeURIComponent(puuid)}?size=10`,
      {
        method: "GET",
        headers: {
          Authorization: cleanKey,
          Accept: "application/json",
        },
      },
    );

    if (v4Res.ok) {
      const v4Body = (await v4Res.json()) as { data?: HenrikMatchesV4Match[] };
      const allMatches = v4Body.data ?? [];
      if (allMatches.length > 0) {
        const compOnly = allMatches.filter(
          (m) => (m.metadata?.queue?.id ?? "").toLowerCase() === "competitive",
        );
        const targetList = compOnly.length > 0 ? compOnly : allMatches;

        let kills = 0;
        let deaths = 0;
        let head = 0;
        let totalShots = 0;
        let counted = 0;
        let accountName: string | null = null;
        let accountTag: string | null = null;
        const targetLower = puuid.toLowerCase();

        for (const m of targetList) {
          const me = (m.players ?? []).find((p) => p.puuid.toLowerCase() === targetLower);
          if (!me) continue;
          counted++;
          // The match document keeps the real Riot ID even when the live
          // roster hides it behind incognito mode.
          if (!accountName && me.name) {
            accountName = me.name;
            accountTag = me.tag || null;
          }
          kills += me.stats?.kills ?? 0;
          deaths += me.stats?.deaths ?? 0;
          const h = me.stats?.headshots ?? 0;
          const b = me.stats?.bodyshots ?? 0;
          const l = me.stats?.legshots ?? 0;
          head += h;
          totalShots += h + b + l;
        }

        if (counted > 0) {
          return {
            kd: Number((deaths > 0 ? kills / deaths : kills).toFixed(2)),
            hsPercent: totalShots > 0 ? Number(((head / totalShots) * 100).toFixed(1)) : null,
            sampleSize: counted,
            accountName,
            accountTag,
          };
        }
      }
    }
  } catch {
    // Ignore fallback error
  }

  return {
    kd: null,
    hsPercent: null,
    sampleSize: 0,
    accountName: null,
    accountTag: null,
  };
}

export async function fetchPlayerRankByPuuid(
  puuid: string,
  region: Region,
  apiKey: string,
): Promise<LivePlayerRankInfo | null> {
  if (!puuid) return null;
  const cacheKey = `live_puuid_stats_v3:${region}:${puuid.toLowerCase()}`;
  const cached = getCachedData<LivePlayerRankInfo>(cacheKey);
  if (cached) return cached;

  const cleanKey = sanitizeApiKey(apiKey);
  if (!cleanKey) return null;

  try {
    const [mmrRes, kdStats] = await Promise.all([
      fetch(
        `${BASE_URL}/valorant/v3/by-puuid/mmr/${region}/pc/${encodeURIComponent(puuid)}`,
        {
          method: "GET",
          headers: {
            Authorization: cleanKey,
            Accept: "application/json",
          },
        },
      ).catch(() => null),
      fetchKdStatsByPuuid(puuid, region, cleanKey),
    ]);

    if (!mmrRes || !mmrRes.ok) {
      if (mmrRes?.status === 404 || kdStats.kd !== null) {
        const fallbackInfo: LivePlayerRankInfo = {
          tierId: 0,
          tierName: "ランクなし",
          rr: 0,
          peakTierId: null,
          peakTierName: null,
          peakSeasonShort: null,
          seasonWins: null,
          seasonGames: null,
          seasonWinRate: null,
          kd: kdStats.kd,
          hsPercent: kdStats.hsPercent,
          kdSampleSize: kdStats.sampleSize,
          accountName: kdStats.accountName,
          accountTag: kdStats.accountTag,
        };
        setCachedData(cacheKey, fallbackInfo, LIVE_PLAYER_CACHE_TTL_MS);
        return fallbackInfo;
      }
      return null;
    }

    const body = (await mmrRes.json()) as { data?: HenrikMmrV3Data };
    const d = body.data;
    if (!d) return null;

    const seasonal = d.seasonal ?? [];
    const latest = seasonal.length > 0 ? seasonal[seasonal.length - 1] : null;
    const wins = latest?.wins ?? 0;
    const games = latest?.games ?? 0;

    const info: LivePlayerRankInfo = {
      tierId: d.current?.tier?.id ?? 0,
      tierName: d.current?.tier?.name ?? "ランクなし",
      rr: d.current?.rr ?? 0,
      peakTierId: d.peak?.tier?.id ?? null,
      peakTierName: d.peak?.tier?.name ?? null,
      peakSeasonShort: d.peak?.season?.short?.toUpperCase() ?? null,
      seasonWins: games > 0 ? wins : null,
      seasonGames: games > 0 ? games : null,
      seasonWinRate: games > 0 ? Number(((wins / games) * 100).toFixed(1)) : null,
      kd: kdStats.kd,
      hsPercent: kdStats.hsPercent,
      kdSampleSize: kdStats.sampleSize,
      // The MMR document is keyed by PUUID, so it still names incognito
      // players whose live roster entry was masked.
      accountName: d.account?.name?.trim() || kdStats.accountName,
      accountTag: d.account?.tag?.trim() || kdStats.accountTag,
    };

    setCachedData(cacheKey, info, LIVE_PLAYER_CACHE_TTL_MS);
    return info;
  } catch {
    return null;
  }
}

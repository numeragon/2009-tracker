import type {
  CompetitiveSummaryStats,
  HenrikAccountV2Data,
  HenrikMatchV2Data,
  HenrikMatchesV4Match,
  HenrikMatchesV4Player,
  HenrikMmrHistoryV1Item,
  HenrikMmrV3Data,
  MatchDetailBundle,
  MatchDetailPlayer,
  MatchModeFilter,
  MatchRoundSummary,
  MatchSummaryItem,
  PlayerProfileBundle,
  Region,
  RrHistoryPoint,
} from "../types/valorant";
import { ApiClientError, normalizeError } from "./errors";
import { getCachedData, sanitizeApiKey, setCachedData } from "./storage";
import { buildPlayerCardUrls } from "./valorantAssets";

const BASE_URL = "https://api.henrikdev.xyz";

interface HenrikEnvelope<T> {
  status: number;
  data: T;
  errors?: Array<{ code?: number; message?: string; status?: number }>;
}

export function parseRiotId(input: string): { name: string; tag: string } {
  const normalized = input.trim().replace(/＃/g, "#");
  const hashIdx = normalized.indexOf("#");
  if (hashIdx <= 0 || hashIdx === normalized.length - 1) {
    throw new ApiClientError(
      "BAD_REQUEST",
      "Riot ID は「名前#タグ」の形式で入力してください（例: Player#JP1）。",
    );
  }
  const name = normalized.slice(0, hashIdx).trim();
  const tag = normalized.slice(hashIdx + 1).trim();
  if (!name || !tag) {
    throw new ApiClientError(
      "BAD_REQUEST",
      "Riot ID は「名前#タグ」の形式で入力してください（例: Player#JP1）。",
    );
  }
  return { name, tag };
}

async function henrikGet<T>(path: string, apiKey: string): Promise<T> {
  const cleanKey = sanitizeApiKey(apiKey);
  if (!cleanKey) {
    throw new ApiClientError(
      "MISSING_API_KEY",
      "HenrikDev APIキーが設定されていません。設定画面からAPIキーを登録してください。",
    );
  }

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: "GET",
      headers: {
        Authorization: cleanKey,
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw normalizeError(err);
  }

  let body: HenrikEnvelope<T> | null = null;
  try {
    body = (await response.json()) as HenrikEnvelope<T>;
  } catch {
    body = null;
  }

  if (!response.ok) {
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new ApiClientError(
        "UNAUTHORIZED",
        "APIキーが無効か、アクセス権限がありません。設定画面でキーを確認してください。",
        status,
      );
    }
    if (status === 404) {
      throw new ApiClientError(
        "NOT_FOUND",
        "プレイヤーが見つからないか、非公開です",
        status,
      );
    }
    if (status === 429) {
      throw new ApiClientError(
        "RATE_LIMIT",
        "APIのレートリミットに達しました。少し待ってから再試行してください。",
        status,
      );
    }
    if (status === 400) {
      throw new ApiClientError(
        "BAD_REQUEST",
        body?.errors?.[0]?.message || "リクエストの形式が正しくありません。",
        status,
      );
    }
    throw new ApiClientError(
      "UNKNOWN",
      `APIエラーが発生しました（HTTP ${status}）。しばらくしてから再試行してください。`,
      status,
    );
  }

  if (!body || body.data === undefined) {
    throw new ApiClientError("UNKNOWN", "APIレスポンスの解析に失敗しました。");
  }

  return body.data;
}

export function formatModeLabel(queueIdOrMode?: string | null, fallbackName?: string | null): string {
  const q = (queueIdOrMode ?? fallbackName ?? "").trim().toLowerCase();
  if (q === "competitive") return "コンペティティブ";
  if (q === "unrated") return "アンレート";
  if (q === "swiftplay") return "スイフトプレイ";
  if (q === "spikerush" || q === "spike rush") return "スパイクラッシュ";
  if (q === "deathmatch") return "デスマッチ";
  if (q === "hurm" || q === "team deathmatch") return "チームデスマッチ";
  if (q === "escalation") return "エスカレーション";
  if (q === "premier") return "プレミア";
  if (q === "custom") return "カスタム";
  return fallbackName || queueIdOrMode || "スタンダード";
}

function isCompetitiveQueue(match: HenrikMatchesV4Match): boolean {
  const qId = (match.metadata.queue?.id ?? "").toLowerCase();
  const qName = (match.metadata.queue?.name ?? "").toLowerCase();
  return qId === "competitive" || qName === "competitive";
}

function findTargetPlayerV4(
  players: HenrikMatchesV4Player[],
  puuid: string,
  name: string,
  tag: string,
): HenrikMatchesV4Player | undefined {
  if (puuid) {
    const byPuuid = players.find((p) => p.puuid === puuid);
    if (byPuuid) return byPuuid;
  }
  const n = name.trim().toLowerCase();
  const t = tag.trim().toLowerCase();
  return players.find(
    (p) => p.name.trim().toLowerCase() === n && p.tag.trim().toLowerCase() === t,
  );
}

export function normalizeMatchesV4(
  rawMatches: HenrikMatchesV4Match[],
  puuid: string,
  name: string,
  tag: string,
  rrByMatchId: Map<string, number>,
): MatchSummaryItem[] {
  const items: MatchSummaryItem[] = [];

  for (const m of rawMatches) {
    const me = findTargetPlayerV4(m.players ?? [], puuid, name, tag);
    if (!me) continue;

    const myTeamId = (me.team_id ?? "").toLowerCase();
    const teams = m.teams ?? [];
    const myTeam = teams.find((t) => (t.team_id ?? "").toLowerCase() === myTeamId);
    const enemyTeam = teams.find((t) => (t.team_id ?? "").toLowerCase() !== myTeamId);

    const myRoundsWon = myTeam?.rounds?.won ?? 0;
    const enemyRoundsWon = myTeam?.rounds?.lost ?? enemyTeam?.rounds?.won ?? 0;
    const roundsFromTeams = myRoundsWon + enemyRoundsWon;
    const roundsPlayed = Math.max(
      1,
      roundsFromTeams > 0 ? roundsFromTeams : (m.rounds?.length ?? 1),
    );

    let result: "win" | "loss" | "draw" = "draw";
    if (myTeam) {
      if (myTeam.won) {
        result = "win";
      } else if (enemyTeam?.won) {
        result = "loss";
      } else if (myRoundsWon > enemyRoundsWon) {
        result = "win";
      } else if (myRoundsWon < enemyRoundsWon) {
        result = "loss";
      }
    }

    const kills = me.stats?.kills ?? 0;
    const deaths = me.stats?.deaths ?? 0;
    const assists = me.stats?.assists ?? 0;
    const score = me.stats?.score ?? 0;
    const damageDealt = me.stats?.damage?.dealt ?? 0;
    const hs = me.stats?.headshots ?? 0;
    const bs = me.stats?.bodyshots ?? 0;
    const ls = me.stats?.legshots ?? 0;
    const totalShots = hs + bs + ls;

    const startedAtIso = m.metadata.started_at ?? "";
    const parsedTime = startedAtIso ? Date.parse(startedAtIso) : 0;
    const isComp = isCompetitiveQueue(m);
    const matchId = m.metadata.match_id;

    items.push({
      matchId,
      startedAtIso,
      startedAtTimestamp: Number.isFinite(parsedTime) ? parsedTime : 0,
      durationSeconds: Math.round((m.metadata.game_length_in_ms ?? 0) / 1000),
      mapId: m.metadata.map?.id ?? "",
      mapName: m.metadata.map?.name ?? "Unknown",
      queueId: (m.metadata.queue?.id ?? "").toLowerCase(),
      modeLabel: formatModeLabel(m.metadata.queue?.id, m.metadata.queue?.name),
      isCompetitive: isComp,
      agentId: me.agent?.id ?? "",
      agentName: me.agent?.name ?? "Unknown",
      result,
      myRoundsWon,
      enemyRoundsWon,
      roundsPlayed,
      kills,
      deaths,
      assists,
      acs: Math.round(score / roundsPlayed),
      adr: Math.round(damageDealt / roundsPlayed),
      hsPercent: totalShots > 0 ? Number(((hs / totalShots) * 100).toFixed(1)) : 0,
      rrChange: rrByMatchId.has(matchId) ? (rrByMatchId.get(matchId) ?? null) : null,
      rawV4: m,
    });
  }

  return items;
}

export function computeCompetitiveSummary(
  compMatches: HenrikMatchesV4Match[],
  puuid: string,
  name: string,
  tag: string,
): CompetitiveSummaryStats {
  const limited = compMatches.slice(0, 20);
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  let totalScore = 0;
  let totalDamage = 0;
  let totalRounds = 0;
  let totalHeadshots = 0;
  let totalShots = 0;
  let counted = 0;

  for (const m of limited) {
    const me = findTargetPlayerV4(m.players ?? [], puuid, name, tag);
    if (!me) continue;
    counted++;

    const myTeamId = (me.team_id ?? "").toLowerCase();
    const myTeam = (m.teams ?? []).find((t) => (t.team_id ?? "").toLowerCase() === myTeamId);
    const enemyTeam = (m.teams ?? []).find((t) => (t.team_id ?? "").toLowerCase() !== myTeamId);

    const wonRounds = myTeam?.rounds?.won ?? 0;
    const lostRounds = myTeam?.rounds?.lost ?? enemyTeam?.rounds?.won ?? 0;
    const rounds = Math.max(1, wonRounds + lostRounds || (m.rounds?.length ?? 1));

    if (myTeam?.won || (!enemyTeam?.won && wonRounds > lostRounds)) {
      wins++;
    } else if (enemyTeam?.won || lostRounds > wonRounds) {
      losses++;
    } else {
      draws++;
    }

    kills += me.stats?.kills ?? 0;
    deaths += me.stats?.deaths ?? 0;
    assists += me.stats?.assists ?? 0;
    totalScore += me.stats?.score ?? 0;
    totalDamage += me.stats?.damage?.dealt ?? 0;
    totalRounds += rounds;

    const hs = me.stats?.headshots ?? 0;
    const bs = me.stats?.bodyshots ?? 0;
    const ls = me.stats?.legshots ?? 0;
    totalHeadshots += hs;
    totalShots += hs + bs + ls;
  }

  const kd = deaths > 0 ? kills / deaths : kills;
  const winRate = counted > 0 ? (wins / counted) * 100 : 0;
  const hsPercent = totalShots > 0 ? (totalHeadshots / totalShots) * 100 : 0;
  const avgAcs = totalRounds > 0 ? Math.round(totalScore / totalRounds) : 0;
  const avgAdr = totalRounds > 0 ? Math.round(totalDamage / totalRounds) : 0;

  return {
    matchesCount: counted,
    wins,
    losses,
    draws,
    winRate: Number(winRate.toFixed(1)),
    kills,
    deaths,
    assists,
    kd: Number(kd.toFixed(2)),
    hsPercent: Number(hsPercent.toFixed(1)),
    avgAcs,
    avgAdr,
  };
}

/**
 * Fetches up to 20 matches from HenrikDev v4 matches endpoint.
 * Note: HenrikDev v4 caps `size` at 10 per page, so we request page 1 (`size=20&start=0`)
 * and if 10 items are returned, we fetch page 2 (`size=10&start=10`) to provide 20 matches.
 */
async function fetchUpTo20MatchesV4(
  region: Region,
  name: string,
  tag: string,
  apiKey: string,
  mode?: Exclude<MatchModeFilter, "all">,
): Promise<HenrikMatchesV4Match[]> {
  const encName = encodeURIComponent(name);
  const encTag = encodeURIComponent(tag);
  const modeParam = mode ? `&mode=${encodeURIComponent(mode)}` : "";

  const firstPage = await henrikGet<HenrikMatchesV4Match[]>(
    `/valorant/v4/matches/${region}/pc/${encName}/${encTag}?size=20&start=0${modeParam}`,
    apiKey,
  ).catch((err) => {
    if (err instanceof ApiClientError && err.kind === "NOT_FOUND") {
      return [] as HenrikMatchesV4Match[];
    }
    throw err;
  });

  if (firstPage.length < 10 || firstPage.length >= 20) {
    return firstPage.slice(0, 20);
  }

  const secondPage = await henrikGet<HenrikMatchesV4Match[]>(
    `/valorant/v4/matches/${region}/pc/${encName}/${encTag}?size=10&start=10${modeParam}`,
    apiKey,
  ).catch(() => [] as HenrikMatchesV4Match[]);

  const seen = new Set(firstPage.map((m) => m.metadata.match_id));
  const combined = [...firstPage];
  for (const m of secondPage) {
    if (!seen.has(m.metadata.match_id)) {
      seen.add(m.metadata.match_id);
      combined.push(m);
    }
  }
  return combined.slice(0, 20);
}

function normalizeRrHistory(items: HenrikMmrHistoryV1Item[]): RrHistoryPoint[] {
  // HenrikDev returns newest first; reverse for chronological left-to-right graph
  const chronological = [...items].slice(0, 20).reverse();
  return chronological.map((item, idx) => {
    const ts = item.date_raw ? item.date_raw * 1000 : Date.parse(item.date);
    const d = Number.isFinite(ts) && ts > 0 ? new Date(ts) : null;
    const dateLabel = d
      ? `${d.getMonth() + 1}/${d.getDate()}`
      : `#${idx + 1}`;
    const fullDate = d
      ? d.toLocaleString("ja-JP", {
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        })
      : item.date;

    return {
      matchId: item.match_id,
      index: idx + 1,
      dateLabel,
      fullDate,
      timestamp: Number.isFinite(ts) ? ts : idx,
      tierId: item.currenttier ?? 0,
      tierName: item.currenttierpatched ?? "Unrated",
      rr: item.ranking_in_tier ?? 0,
      elo: item.elo ?? 0,
      rrChange: item.mmr_change_to_last_game ?? 0,
      mapName: item.map?.name,
    };
  });
}

export async function fetchPlayerProfile(
  rawName: string,
  rawTag: string,
  region: Region,
  apiKey: string,
  options?: { forceRefresh?: boolean },
): Promise<PlayerProfileBundle> {
  const cleanKey = sanitizeApiKey(apiKey);
  if (!cleanKey) {
    throw new ApiClientError(
      "MISSING_API_KEY",
      "HenrikDev APIキーが未設定です。設定画面でAPIキーを入力してください。",
    );
  }

  const name = rawName.trim();
  const tag = rawTag.trim();
  const cacheKey = `profile:${region}:${name.toLowerCase()}#${tag.toLowerCase()}`;

  if (!options?.forceRefresh) {
    const cached = getCachedData<PlayerProfileBundle>(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const encName = encodeURIComponent(name);
  const encTag = encodeURIComponent(tag);

  // 1. Account v2 is authoritative for existence / privacy check
  const account = await henrikGet<HenrikAccountV2Data>(
    `/valorant/v2/account/${encName}/${encTag}`,
    cleanKey,
  );

  // 2. Fetch MMR v3, MMR History v1, and recent 20 matches in parallel
  const [mmrData, mmrHistoryRaw, allMatchesRaw] = await Promise.all([
    henrikGet<HenrikMmrV3Data>(
      `/valorant/v3/mmr/${region}/pc/${encName}/${encTag}`,
      cleanKey,
    ).catch((err) => {
      if (err instanceof ApiClientError && err.kind === "NOT_FOUND") return null;
      throw err;
    }),
    henrikGet<HenrikMmrHistoryV1Item[]>(
      `/valorant/v1/mmr-history/${region}/${encName}/${encTag}`,
      cleanKey,
    ).catch((err) => {
      if (err instanceof ApiClientError && err.kind === "NOT_FOUND") return [] as HenrikMmrHistoryV1Item[];
      throw err;
    }),
    fetchUpTo20MatchesV4(region, account.name || name, account.tag || tag, cleanKey),
  ]);

  // 3. Ensure up to 20 Competitive matches for §4.2 summary stats
  const compInAll = allMatchesRaw.filter(isCompetitiveQueue);
  let compMatchesForStats = compInAll;
  if (allMatchesRaw.length >= 10 && compInAll.length < 20 && compInAll.length < allMatchesRaw.length) {
    try {
      const dedicatedComp = await fetchUpTo20MatchesV4(
        region,
        account.name || name,
        account.tag || tag,
        cleanKey,
        "competitive",
      );
      if (dedicatedComp.length > compInAll.length) {
        compMatchesForStats = dedicatedComp;
      }
      // Cache dedicated competitive list too
      const rrMapTmp = new Map<string, number>();
      for (const h of mmrHistoryRaw) {
        if (h.match_id) rrMapTmp.set(h.match_id, h.mmr_change_to_last_game);
      }
      const normalizedComp = normalizeMatchesV4(
        dedicatedComp,
        account.puuid,
        account.name,
        account.tag,
        rrMapTmp,
      );
      setCachedData(
        `matches:${region}:${account.name.toLowerCase()}#${account.tag.toLowerCase()}:competitive`,
        normalizedComp,
      );
    } catch {
      // Fall back to competitive matches already present in allMatchesRaw
    }
  }

  const rrByMatchId = new Map<string, number>();
  for (const h of mmrHistoryRaw) {
    if (h.match_id) {
      rrByMatchId.set(h.match_id, h.mmr_change_to_last_game);
    }
  }

  const matches = normalizeMatchesV4(
    allMatchesRaw,
    account.puuid,
    account.name,
    account.tag,
    rrByMatchId,
  );

  setCachedData(
    `matches:${region}:${account.name.toLowerCase()}#${account.tag.toLowerCase()}:all`,
    matches,
  );

  const cards = buildPlayerCardUrls(account.card);

  const placementRaw = mmrData?.current?.leaderboard_placement;
  const leaderboardRank =
    typeof placementRaw === "number"
      ? placementRaw
      : placementRaw && typeof placementRaw === "object" && typeof placementRaw.rank === "number"
        ? placementRaw.rank
        : null;

  const seasonalList = mmrData?.seasonal ?? [];
  const latestSeason = seasonalList.length > 0 ? seasonalList[seasonalList.length - 1] : null;
  const seasonWins = latestSeason?.wins ?? 0;
  const seasonGames = latestSeason?.games ?? 0;
  const seasonLosses = Math.max(0, seasonGames - seasonWins);

  const bundle: PlayerProfileBundle = {
    puuid: account.puuid,
    name: account.name || name,
    tag: account.tag || tag,
    region,
    accountLevel: account.account_level ?? 0,
    cardId: cards.cardId,
    cardWideUrl: cards.wide,
    cardSmallUrl: cards.small,
    cardLargeUrl: cards.large,
    currentRank: {
      tierId: mmrData?.current?.tier?.id ?? 0,
      tierName: mmrData?.current?.tier?.name ?? "Unrated",
      rr: mmrData?.current?.rr ?? 0,
      lastChange: mmrData?.current?.last_change ?? 0,
      elo: mmrData?.current?.elo ?? 0,
      leaderboardRank,
    },
    peakRank: mmrData?.peak?.tier
      ? {
          tierId: mmrData.peak.tier.id,
          tierName: mmrData.peak.tier.name,
          seasonShort: mmrData.peak.season?.short?.toUpperCase() ?? null,
        }
      : null,
    seasonStats:
      latestSeason && seasonGames > 0
        ? {
            seasonShort: latestSeason.season?.short?.toUpperCase() ?? null,
            wins: seasonWins,
            losses: seasonLosses,
            games: seasonGames,
            winRate: Number(((seasonWins / seasonGames) * 100).toFixed(1)),
          }
        : null,
    competitiveSummary: computeCompetitiveSummary(
      compMatchesForStats,
      account.puuid,
      account.name || name,
      account.tag || tag,
    ),
    rrHistory: normalizeRrHistory(mmrHistoryRaw),
    matches,
    fetchedAt: Date.now(),
  };

  setCachedData(cacheKey, bundle);
  // Also cache under canonical case returned by API
  const canonicalKey = `profile:${region}:${bundle.name.toLowerCase()}#${bundle.tag.toLowerCase()}`;
  if (canonicalKey !== cacheKey) {
    setCachedData(canonicalKey, bundle);
  }

  return bundle;
}

export async function fetchFilteredMatches(
  profile: PlayerProfileBundle,
  mode: MatchModeFilter,
  apiKey: string,
  options?: { forceRefresh?: boolean },
): Promise<MatchSummaryItem[]> {
  if (mode === "all" && !options?.forceRefresh) {
    return profile.matches;
  }

  const cacheKey = `matches:${profile.region}:${profile.name.toLowerCase()}#${profile.tag.toLowerCase()}:${mode}`;
  if (!options?.forceRefresh) {
    const cached = getCachedData<MatchSummaryItem[]>(cacheKey);
    if (cached) return cached;
  }

  const rrByMatchId = new Map<string, number>();
  for (const pt of profile.rrHistory) {
    rrByMatchId.set(pt.matchId, pt.rrChange);
  }
  for (const m of profile.matches) {
    if (m.rrChange !== null) {
      rrByMatchId.set(m.matchId, m.rrChange);
    }
  }

  const raw = await fetchUpTo20MatchesV4(
    profile.region,
    profile.name,
    profile.tag,
    apiKey,
    mode === "all" ? undefined : mode,
  );

  const normalized = normalizeMatchesV4(
    raw,
    profile.puuid,
    profile.name,
    profile.tag,
    rrByMatchId,
  );

  setCachedData(cacheKey, normalized);
  return normalized;
}

function normalizeMatchV2(data: HenrikMatchV2Data): MatchDetailBundle {
  const roundsPlayed = Math.max(1, data.metadata.rounds_played || (data.rounds?.length ?? 1));

  const mapPlayer = (p: HenrikMatchV2Data["players"]["all_players"][number]): MatchDetailPlayer => {
    const kills = p.stats?.kills ?? 0;
    const deaths = p.stats?.deaths ?? 0;
    const assists = p.stats?.assists ?? 0;
    const score = p.stats?.score ?? 0;
    const hs = p.stats?.headshots ?? 0;
    const bs = p.stats?.bodyshots ?? 0;
    const ls = p.stats?.legshots ?? 0;
    const shots = hs + bs + ls;

    return {
      puuid: p.puuid,
      name: p.name,
      tag: p.tag,
      team: p.team ?? "Neutral",
      level: p.level ?? 0,
      agentName: p.character ?? "Unknown",
      agentIconUrl: p.assets?.agent?.small,
      tierId: p.currenttier ?? 0,
      tierName: p.currenttier_patched ?? "Unrated",
      kills,
      deaths,
      assists,
      kd: Number((deaths > 0 ? kills / deaths : kills).toFixed(2)),
      acs: Math.round(score / roundsPlayed),
      adr: typeof p.damage_made === "number" ? Math.round(p.damage_made / roundsPlayed) : null,
      hsPercent: shots > 0 ? Number(((hs / shots) * 100).toFixed(1)) : 0,
      avgSpent:
        typeof p.economy?.spent?.average === "number"
          ? Math.round(p.economy.spent.average)
          : null,
      avgLoadout:
        typeof p.economy?.loadout_value?.average === "number"
          ? Math.round(p.economy.loadout_value.average)
          : null,
      partyId: p.party_id,
    };
  };

  const allMapped = (data.players?.all_players ?? []).map(mapPlayer);
  const sortByAcs = (a: MatchDetailPlayer, b: MatchDetailPlayer) => b.acs - a.acs || b.kills - a.kills;

  const bluePlayers = allMapped.filter((p) => p.team.toLowerCase() === "blue").sort(sortByAcs);
  const redPlayers = allMapped.filter((p) => p.team.toLowerCase() === "red").sort(sortByAcs);
  const otherPlayers = allMapped
    .filter((p) => {
      const t = p.team.toLowerCase();
      return t !== "blue" && t !== "red";
    })
    .sort(sortByAcs);

  const rounds: MatchRoundSummary[] = (data.rounds ?? []).map((r, idx) => ({
    roundNumber: idx + 1,
    winningTeam: r.winning_team ?? "",
    endType: r.end_type ?? "",
    bombPlanted: Boolean(r.bomb_planted),
    bombDefused: Boolean(r.bomb_defused),
  }));

  const startedAtIso = data.metadata.game_start
    ? new Date(data.metadata.game_start * 1000).toISOString()
    : data.metadata.game_start_patched ?? "";

  return {
    matchId: data.metadata.matchid,
    mapName: data.metadata.map ?? "Unknown",
    modeLabel: formatModeLabel(data.metadata.mode_id ?? data.metadata.queue, data.metadata.mode),
    startedAtIso,
    durationSeconds: data.metadata.game_length ?? 0,
    roundsPlayed,
    cluster: data.metadata.cluster,
    teams: {
      blue: {
        roundsWon: data.teams?.blue?.rounds_won ?? 0,
        hasWon: Boolean(data.teams?.blue?.has_won),
        players: bluePlayers,
      },
      red: {
        roundsWon: data.teams?.red?.rounds_won ?? 0,
        hasWon: Boolean(data.teams?.red?.has_won),
        players: redPlayers,
      },
    },
    otherPlayers,
    rounds,
  };
}

export function normalizeMatchDetailFromV4(data: HenrikMatchesV4Match): MatchDetailBundle {
  const teamsArr = data.teams ?? [];
  const blueRaw = teamsArr.find((t) => (t.team_id ?? "").toLowerCase() === "blue");
  const redRaw = teamsArr.find((t) => (t.team_id ?? "").toLowerCase() === "red");
  const roundsFromTeams = (blueRaw?.rounds?.won ?? 0) + (blueRaw?.rounds?.lost ?? 0);
  const roundsPlayed = Math.max(1, roundsFromTeams || (data.rounds?.length ?? 1));

  const mapPlayer = (p: HenrikMatchesV4Player): MatchDetailPlayer => {
    const kills = p.stats?.kills ?? 0;
    const deaths = p.stats?.deaths ?? 0;
    const assists = p.stats?.assists ?? 0;
    const score = p.stats?.score ?? 0;
    const hs = p.stats?.headshots ?? 0;
    const bs = p.stats?.bodyshots ?? 0;
    const ls = p.stats?.legshots ?? 0;
    const shots = hs + bs + ls;

    return {
      puuid: p.puuid,
      name: p.name,
      tag: p.tag,
      team: p.team_id ?? "Neutral",
      level: p.account_level ?? 0,
      agentId: p.agent?.id,
      agentName: p.agent?.name ?? "Unknown",
      tierId: p.tier?.id ?? 0,
      tierName: p.tier?.name ?? "Unrated",
      kills,
      deaths,
      assists,
      kd: Number((deaths > 0 ? kills / deaths : kills).toFixed(2)),
      acs: Math.round(score / roundsPlayed),
      adr:
        typeof p.stats?.damage?.dealt === "number"
          ? Math.round(p.stats.damage.dealt / roundsPlayed)
          : null,
      hsPercent: shots > 0 ? Number(((hs / shots) * 100).toFixed(1)) : 0,
      avgSpent:
        typeof p.economy?.spent?.average === "number"
          ? Math.round(p.economy.spent.average)
          : null,
      avgLoadout:
        typeof p.economy?.loadout_value?.average === "number"
          ? Math.round(p.economy.loadout_value.average)
          : null,
      partyId: p.party_id,
    };
  };

  const allMapped = (data.players ?? []).map(mapPlayer);
  const sortByAcs = (a: MatchDetailPlayer, b: MatchDetailPlayer) => b.acs - a.acs || b.kills - a.kills;

  return {
    matchId: data.metadata.match_id,
    mapId: data.metadata.map?.id,
    mapName: data.metadata.map?.name ?? "Unknown",
    modeLabel: formatModeLabel(data.metadata.queue?.id, data.metadata.queue?.name),
    startedAtIso: data.metadata.started_at ?? "",
    durationSeconds: Math.round((data.metadata.game_length_in_ms ?? 0) / 1000),
    roundsPlayed,
    cluster: data.metadata.cluster,
    teams: {
      blue: {
        roundsWon: blueRaw?.rounds?.won ?? 0,
        hasWon: Boolean(blueRaw?.won),
        players: allMapped.filter((p) => p.team.toLowerCase() === "blue").sort(sortByAcs),
      },
      red: {
        roundsWon: redRaw?.rounds?.won ?? 0,
        hasWon: Boolean(redRaw?.won),
        players: allMapped.filter((p) => p.team.toLowerCase() === "red").sort(sortByAcs),
      },
    },
    otherPlayers: allMapped
      .filter((p) => {
        const t = p.team.toLowerCase();
        return t !== "blue" && t !== "red";
      })
      .sort(sortByAcs),
    rounds: (data.rounds ?? []).map((r, idx) => ({
      roundNumber: (r.id ?? idx) + 1,
      winningTeam: r.winning_team ?? "",
      endType: r.result ?? "",
      bombPlanted: false,
      bombDefused: false,
    })),
  };
}

export async function fetchMatchDetail(
  matchId: string,
  apiKey: string,
  fallbackV4?: HenrikMatchesV4Match,
): Promise<MatchDetailBundle> {
  const cacheKey = `match_detail:${matchId}`;
  const cached = getCachedData<MatchDetailBundle>(cacheKey);
  if (cached) return cached;

  try {
    const raw = await henrikGet<HenrikMatchV2Data>(
      `/valorant/v2/match/${encodeURIComponent(matchId)}`,
      apiKey,
    );
    const detail = normalizeMatchV2(raw);
    setCachedData(cacheKey, detail);
    return detail;
  } catch (err) {
    if (fallbackV4) {
      const fallbackDetail = normalizeMatchDetailFromV4(fallbackV4);
      setCachedData(cacheKey, fallbackDetail);
      return fallbackDetail;
    }
    throw err;
  }
}

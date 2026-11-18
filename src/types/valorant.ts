export type Region = "ap" | "eu" | "na" | "kr" | "latam" | "br";

export type MatchModeFilter = "all" | "competitive" | "unrated" | "swiftplay";

export interface AppSettings {
  apiKey: string;
  defaultRegion: Region;
}

export interface SavedPlayerEntry {
  name: string;
  tag: string;
  region: Region;
  cardId?: string;
  accountLevel?: number;
  tierId?: number;
  tierName?: string;
  updatedAt: number;
}

/* =========================================================
 * HenrikDev API Raw Schemas (verified against OpenAPI spec)
 * ========================================================= */

export interface HenrikAccountV2Data {
  puuid: string;
  region: string;
  account_level: number;
  name: string;
  tag: string;
  card: string | { id?: string; small?: string; large?: string; wide?: string };
  title: string;
  platforms?: string[];
  updated_at?: string;
}

export interface HenrikMmrV3Seasonal {
  season: { id: string; short: string };
  wins: number;
  games: number;
  end_tier?: { id: number; name: string };
  end_rr?: number;
}

export interface HenrikMmrV3Data {
  account: { puuid: string; name: string; tag: string };
  current: {
    tier: { id: number; name: string };
    rr: number;
    last_change: number;
    elo: number;
    games_needed_for_rating?: number;
    leaderboard_placement?: { rank: number; updated_at?: string } | number | null;
  };
  peak?: {
    season?: { id: string; short: string };
    tier: { id: number; name: string };
    rr?: number;
  } | null;
  seasonal?: HenrikMmrV3Seasonal[];
}

export interface HenrikMmrHistoryV1Item {
  currenttier: number;
  currenttierpatched: string;
  images?: {
    small?: string;
    large?: string;
  };
  match_id: string;
  map?: { id?: string; name?: string };
  season_id?: string;
  ranking_in_tier: number;
  mmr_change_to_last_game: number;
  elo: number;
  date: string;
  date_raw: number;
}

export interface HenrikMatchesV4Player {
  puuid: string;
  name: string;
  tag: string;
  team_id: string;
  account_level?: number;
  party_id?: string;
  agent?: { id: string; name: string };
  tier?: { id: number; name: string };
  customization?: {
    card?: string;
    title?: string;
  };
  stats: {
    score: number;
    kills: number;
    deaths: number;
    assists: number;
    headshots: number;
    bodyshots: number;
    legshots: number;
    damage?: {
      dealt: number;
      received: number;
    };
  };
  economy?: {
    spent?: { overall: number; average: number };
    loadout_value?: { overall: number; average: number };
  };
}

export interface HenrikMatchesV4Team {
  team_id: string;
  won: boolean;
  rounds: {
    won: number;
    lost: number;
  };
}

export interface HenrikMatchesV4Match {
  metadata: {
    match_id: string;
    map?: { id: string; name: string };
    game_version?: string;
    game_length_in_ms?: number;
    started_at?: string;
    is_completed?: boolean;
    queue?: {
      id: string;
      name?: string | null;
      mode_type?: string | null;
    };
    region?: string | null;
    cluster?: string | null;
    season?: { id: string; short: string };
  };
  players: HenrikMatchesV4Player[];
  teams: HenrikMatchesV4Team[];
  rounds?: Array<{
    id?: number;
    result?: string;
    winning_team?: string;
  }>;
}

export interface HenrikMatchV2Player {
  puuid: string;
  name: string;
  tag: string;
  team: string;
  level?: number;
  character?: string | null;
  currenttier?: number;
  currenttier_patched?: string;
  player_card?: string;
  party_id?: string;
  stats: {
    score: number;
    kills: number;
    deaths: number;
    assists: number;
    headshots: number;
    bodyshots: number;
    legshots: number;
  };
  damage_made?: number;
  damage_received?: number;
  economy?: {
    spent?: { overall: number; average: number };
    loadout_value?: { overall: number; average: number };
  };
  assets?: {
    card?: { small?: string; large?: string; wide?: string };
    agent?: { small?: string; bust?: string; full?: string; killfeed?: string };
  };
}

export interface HenrikMatchV2Round {
  winning_team: string;
  end_type: string;
  bomb_planted: boolean;
  bomb_defused: boolean;
}

export interface HenrikMatchV2Data {
  metadata: {
    matchid: string;
    map?: string | null;
    game_version?: string;
    game_length: number;
    game_start: number;
    game_start_patched?: string;
    rounds_played: number;
    mode?: string | null;
    mode_id?: string;
    queue?: string | null;
    region?: string | null;
    cluster?: string | null;
  };
  players: {
    all_players: HenrikMatchV2Player[];
    red?: HenrikMatchV2Player[];
    blue?: HenrikMatchV2Player[];
  };
  teams?: {
    red?: { has_won?: boolean | null; rounds_won?: number | null; rounds_lost?: number | null };
    blue?: { has_won?: boolean | null; rounds_won?: number | null; rounds_lost?: number | null };
  };
  rounds?: HenrikMatchV2Round[];
}

/* =========================================================
 * Normalized Domain Models for UI
 * ========================================================= */

export interface CompetitiveSummaryStats {
  matchesCount: number;
  wins: number;
  losses: number;
  draws: number;
  winRate: number;
  kills: number;
  deaths: number;
  assists: number;
  kd: number;
  hsPercent: number;
  avgAcs: number;
  avgAdr: number;
}

export interface RrHistoryPoint {
  matchId: string;
  index: number;
  dateLabel: string;
  fullDate: string;
  timestamp: number;
  tierId: number;
  tierName: string;
  rr: number;
  elo: number;
  rrChange: number;
  mapName?: string;
}

export interface MatchSummaryItem {
  matchId: string;
  startedAtIso: string;
  startedAtTimestamp: number;
  durationSeconds: number;
  mapId: string;
  mapName: string;
  queueId: string;
  modeLabel: string;
  isCompetitive: boolean;
  agentId: string;
  agentName: string;
  result: "win" | "loss" | "draw";
  myRoundsWon: number;
  enemyRoundsWon: number;
  roundsPlayed: number;
  kills: number;
  deaths: number;
  assists: number;
  acs: number;
  adr: number;
  hsPercent: number;
  rrChange: number | null;
  rawV4?: HenrikMatchesV4Match;
}

export interface PlayerProfileBundle {
  puuid: string;
  name: string;
  tag: string;
  region: Region;
  accountLevel: number;
  cardId: string;
  cardWideUrl: string;
  cardSmallUrl: string;
  cardLargeUrl: string;
  currentRank: {
    tierId: number;
    tierName: string;
    rr: number;
    lastChange: number;
    elo: number;
    leaderboardRank: number | null;
  };
  peakRank: {
    tierId: number;
    tierName: string;
    seasonShort: string | null;
  } | null;
  seasonStats: {
    seasonShort: string | null;
    wins: number;
    losses: number;
    games: number;
    winRate: number;
  } | null;
  competitiveSummary: CompetitiveSummaryStats;
  rrHistory: RrHistoryPoint[];
  matches: MatchSummaryItem[];
  fetchedAt: number;
}

export interface MatchDetailPlayer {
  puuid: string;
  name: string;
  tag: string;
  team: string;
  level: number;
  agentId?: string;
  agentName: string;
  agentIconUrl?: string;
  tierId: number;
  tierName: string;
  kills: number;
  deaths: number;
  assists: number;
  kd: number;
  acs: number;
  adr: number | null;
  hsPercent: number;
  avgSpent: number | null;
  avgLoadout: number | null;
  partyId?: string;
}

export interface MatchRoundSummary {
  roundNumber: number;
  winningTeam: string;
  endType: string;
  bombPlanted: boolean;
  bombDefused: boolean;
}

export interface MatchDetailBundle {
  matchId: string;
  mapName: string;
  mapId?: string;
  modeLabel: string;
  startedAtIso: string;
  durationSeconds: number;
  roundsPlayed: number;
  cluster?: string | null;
  teams: {
    blue: {
      roundsWon: number;
      hasWon: boolean;
      players: MatchDetailPlayer[];
    };
    red: {
      roundsWon: number;
      hasWon: boolean;
      players: MatchDetailPlayer[];
    };
  };
  otherPlayers: MatchDetailPlayer[];
  rounds: MatchRoundSummary[];
}

export interface AgentAsset {
  uuid: string;
  displayName: string;
  displayIcon: string;
  bustPortrait?: string;
}

export interface MapAsset {
  uuid: string;
  displayName: string;
  mapUrl?: string;
  listViewIcon?: string;
  splash?: string;
}

export interface LiveMatchPlayerRaw {
  puuid: string;
  gameName: string;
  tagLine: string;
  teamId: string;
  isAlly: boolean;
  isSelf: boolean;
  agentId: string;
  selectionState: string;
  accountLevel: number;
  hideAccountLevel: boolean;
  isIncognito: boolean;
  cardId: string;
  pregameTier: number;
}

export interface LiveMatchResponse {
  status: "NOT_RUNNING" | "IN_MENU" | "PREGAME" | "IN_GAME" | "ERROR";
  message: string | null;
  matchId: string | null;
  mapUrl: string | null;
  modeId: string | null;
  queueId: string | null;
  serverPod: string | null;
  detectedRegion: string | null;
  detectedShard: string | null;
  selfPuuid: string | null;
  players: LiveMatchPlayerRaw[];
}

export interface LivePlayerRankInfo {
  tierId: number;
  tierName: string;
  rr: number;
  peakTierId: number | null;
  peakTierName: string | null;
  peakSeasonShort: string | null;
  seasonWins: number | null;
  seasonGames: number | null;
  seasonWinRate: number | null;
  kd: number | null;
  hsPercent: number | null;
  kdSampleSize: number;
}

export interface TierAsset {
  tier: number;
  tierName: string;
  smallIcon?: string;
  largeIcon?: string;
}

export interface WeaponAsset {
  uuid: string;
  displayName: string;
  displayIcon?: string;
}

export interface HenrikLeaderboardV3Threshold {
  tier: { id: number; name: string };
  start_index: number;
  threshold: number;
}

export interface HenrikLeaderboardV3Player {
  card?: string | null;
  title?: string | null;
  is_banned?: boolean;
  is_anonymized?: boolean;
  puuid?: string | null;
  name?: string | null;
  tag?: string | null;
  leaderboard_rank: number;
  tier: number;
  rr: number;
  wins: number;
  updated_at?: string;
}

export interface LeaderboardThresholdItem {
  tierId: number;
  tierName: string;
  startIndex: number;
  rrThreshold: number;
}

export interface LeaderboardPlayerItem {
  rank: number;
  puuid: string | null;
  name: string;
  tag: string;
  isAnonymized: boolean;
  isBanned: boolean;
  tierId: number;
  rr: number;
  wins: number;
  cardId: string | null;
  cardSmallUrl: string | null;
  cardWideUrl: string | null;
}

export interface LeaderboardSliceBundle {
  region: Region;
  totalPlayers: number;
  startIndex: number;
  updatedAtIso: string | null;
  thresholds: LeaderboardThresholdItem[];
  players: LeaderboardPlayerItem[];
}

export interface LeaderboardLookupResult {
  foundOnLeaderboard: boolean;
  region: Region;
  name: string;
  tag: string;
  entry: LeaderboardPlayerItem | null;
  fallbackRank?: {
    tierId: number;
    tierName: string;
    rr: number;
  } | null;
}

export interface ValorantAssetsCatalog {
  agentsById: Record<string, AgentAsset>;
  agentsByKey: Record<string, AgentAsset>;
  mapsById: Record<string, MapAsset>;
  mapsByKey: Record<string, MapAsset>;
  tiersById: Record<number, TierAsset>;
  weaponsById: Record<string, WeaponAsset>;
}

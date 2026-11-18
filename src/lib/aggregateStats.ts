import type {
  AgentStatItem,
  MapStatItem,
  MatchSummaryItem,
  PlayerProfileBundle,
} from "../types/valorant";

interface Accumulator {
  key: string;
  label: string;
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  kills: number;
  deaths: number;
  assists: number;
  rounds: number;
  scoreRounds: number;
  damageRounds: number;
  hsRounds: number;
}

function createAccumulator(key: string, label: string): Accumulator {
  return {
    key,
    label,
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    rounds: 0,
    scoreRounds: 0,
    damageRounds: 0,
    hsRounds: 0,
  };
}

function accumulate(acc: Accumulator, m: MatchSummaryItem) {
  acc.matches += 1;
  if (m.result === "win") acc.wins += 1;
  else if (m.result === "loss") acc.losses += 1;
  else acc.draws += 1;

  acc.kills += m.kills;
  acc.deaths += m.deaths;
  acc.assists += m.assists;

  // ACS / ADR / HS% are per-match values; weight them by rounds played so the
  // aggregate matches what the API would report for the combined sample.
  const rounds = Math.max(1, m.roundsPlayed);
  acc.rounds += rounds;
  acc.scoreRounds += m.acs * rounds;
  acc.damageRounds += m.adr * rounds;
  acc.hsRounds += m.hsPercent * rounds;
}

function finalize(acc: Accumulator) {
  const decided = acc.wins + acc.losses;
  return {
    matches: acc.matches,
    wins: acc.wins,
    losses: acc.losses,
    draws: acc.draws,
    winRate: decided > 0 ? Number(((acc.wins / decided) * 100).toFixed(1)) : 0,
    kills: acc.kills,
    deaths: acc.deaths,
    assists: acc.assists,
    kd: Number((acc.deaths > 0 ? acc.kills / acc.deaths : acc.kills).toFixed(2)),
    avgAcs: acc.rounds > 0 ? Math.round(acc.scoreRounds / acc.rounds) : 0,
    avgAdr: acc.rounds > 0 ? Math.round(acc.damageRounds / acc.rounds) : 0,
    hsPercent: acc.rounds > 0 ? Number((acc.hsRounds / acc.rounds).toFixed(1)) : 0,
  };
}

export function collectAgentStats(matches: MatchSummaryItem[]): AgentStatItem[] {
  const byAgent = new Map<string, Accumulator>();

  for (const m of matches) {
    if (!m.agentName || m.agentName === "Unknown") continue;
    const key = m.agentId || m.agentName.toLowerCase();
    let acc = byAgent.get(key);
    if (!acc) {
      acc = createAccumulator(key, m.agentName);
      byAgent.set(key, acc);
    }
    accumulate(acc, m);
  }

  return [...byAgent.values()]
    .map((acc) => {
      const stats = finalize(acc);
      return {
        agentId: acc.key,
        agentName: acc.label,
        ...stats,
      } satisfies AgentStatItem;
    })
    .sort(
      (a, b) =>
        b.matches - a.matches ||
        b.winRate - a.winRate ||
        b.avgAcs - a.avgAcs ||
        a.agentName.localeCompare(b.agentName),
    );
}

export function collectMapStats(matches: MatchSummaryItem[]): MapStatItem[] {
  const byMap = new Map<string, Accumulator>();

  for (const m of matches) {
    if (!m.mapName || m.mapName === "Unknown") continue;
    const key = m.mapId || m.mapName.toLowerCase();
    let acc = byMap.get(key);
    if (!acc) {
      acc = createAccumulator(key, m.mapName);
      byMap.set(key, acc);
    }
    accumulate(acc, m);
  }

  return [...byMap.values()]
    .map((acc) => {
      const stats = finalize(acc);
      return {
        mapId: acc.key,
        mapName: acc.label,
        ...stats,
      } satisfies MapStatItem;
    })
    .sort(
      (a, b) =>
        b.matches - a.matches ||
        b.winRate - a.winRate ||
        a.mapName.localeCompare(b.mapName),
    );
}

export interface PlayerAggregatedStats {
  agents: AgentStatItem[];
  maps: MapStatItem[];
  sampleSize: number;
}

export function aggregateProfileStats(profile: PlayerProfileBundle): PlayerAggregatedStats {
  return {
    agents: collectAgentStats(profile.matches),
    maps: collectMapStats(profile.matches),
    sampleSize: profile.matches.length,
  };
}

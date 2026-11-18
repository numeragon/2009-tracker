import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bookmark,
  Check,
  Clock,
  Radio,
  RefreshCw,
  Server,
  ShieldAlert,
  X,
} from "lucide-react";
import type {
  LiveMatchPlayerRaw,
  LiveMatchResponse,
  LivePlayerRankInfo,
  Region,
  ValorantAssetsCatalog,
} from "../types/valorant";
import {
  fetchLiveMatchFromClient,
  fetchPlayerRankByPuuid,
  formatLiveModeLabel,
  normalizeRegion,
} from "../lib/liveMatchApi";
import {
  resolveAgentAsset,
  resolveMapAsset,
  resolveTierAsset,
} from "../lib/valorantAssets";

const SAVED_LIVE_TABS_KEY = "vt:saved_live_tabs_v1";
const LAST_LIVE_CACHE_KEY = "vt:last_live_session_v1";
const MAX_SAVED_TABS = 12;

export interface SavedLiveMatchTab {
  id: string;
  matchId: string | null;
  label: string;
  savedAt: number;
  region: Region;
  liveData: LiveMatchResponse;
  ranksByPuuid: Record<string, LivePlayerRankInfo | undefined>;
}

function loadSavedTabsFromStorage(): SavedLiveMatchTab[] {
  try {
    const raw = localStorage.getItem(SAVED_LIVE_TABS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedLiveMatchTab[]) : [];
  } catch {
    return [];
  }
}

function saveTabsToStorage(tabs: SavedLiveMatchTab[]) {
  try {
    localStorage.setItem(SAVED_LIVE_TABS_KEY, JSON.stringify(tabs.slice(0, MAX_SAVED_TABS)));
  } catch {
    // Ignore storage quota errors
  }
}

function loadLastLiveCache(): {
  liveData: LiveMatchResponse | null;
  ranksByPuuid: Record<string, LivePlayerRankInfo | undefined>;
} {
  try {
    const raw = localStorage.getItem(LAST_LIVE_CACHE_KEY);
    if (!raw) return { liveData: null, ranksByPuuid: {} };
    const parsed = JSON.parse(raw) as {
      liveData?: LiveMatchResponse | null;
      ranksByPuuid?: Record<string, LivePlayerRankInfo | undefined>;
    };
    return {
      liveData: parsed.liveData ?? null,
      ranksByPuuid: parsed.ranksByPuuid ?? {},
    };
  } catch {
    return { liveData: null, ranksByPuuid: {} };
  }
}

function saveLastLiveCache(
  liveData: LiveMatchResponse | null,
  ranksByPuuid: Record<string, LivePlayerRankInfo | undefined>,
) {
  try {
    localStorage.setItem(
      LAST_LIVE_CACHE_KEY,
      JSON.stringify({ liveData, ranksByPuuid }),
    );
  } catch {
    // Ignore
  }
}

function formatSavedTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

interface LiveTeamTableProps {
  title: string;
  isAllyTable: boolean;
  players: LiveMatchPlayerRaw[];
  ranksByPuuid: Record<string, LivePlayerRankInfo | undefined>;
  isRanksLoading: boolean;
  isPregame: boolean;
  assets: ValorantAssetsCatalog;
  onSelectPlayer: (name: string, tag: string) => void;
}

function LiveTeamTable({
  title,
  isAllyTable,
  players,
  ranksByPuuid,
  isRanksLoading,
  isPregame,
  assets,
  onSelectPlayer,
}: LiveTeamTableProps) {
  return (
    <section className="vt-panel overflow-hidden">
      <div className="px-5 py-3.5 flex items-center justify-between vt-hairline-b bg-[#0a0a0a]">
        <div className="flex items-center gap-2.5">
          <span
            className={`w-2 h-2 rounded-full ${
              isAllyTable ? "bg-[var(--semantic-win)]" : "bg-[var(--semantic-loss)]"
            }`}
          />
          <h2 className="text-xs font-medium text-[#ededed]">{title}</h2>
        </div>
        <span className="font-num text-xs text-[#5c5c5c]">{players.length} 人</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[740px]">
          <thead>
            <tr className="text-[11px] text-[#5c5c5c] vt-hairline-b">
              <th className="py-2.5 pl-5 pr-3 font-normal">プレイヤー / エージェント</th>
              <th className="py-2.5 px-3 font-normal">レベル</th>
              <th className="py-2.5 px-3 font-normal">現在ランク</th>
              <th className="py-2.5 px-3 font-normal">ピークランク</th>
              <th className="py-2.5 px-3 font-normal text-right">K/D</th>
              <th className="py-2.5 pl-3 pr-5 font-normal text-right">今シーズン勝率</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[rgba(255,255,255,0.06)] text-xs">
            {players.map((p) => {
              const agent = p.agentId ? resolveAgentAsset(assets, p.agentId, null) : undefined;
              const rank = ranksByPuuid[p.puuid.toLowerCase()];
              const effectiveTierId = rank?.tierId ?? p.pregameTier ?? 0;
              const currentTierAsset = resolveTierAsset(assets, effectiveTierId);
              const peakTierAsset =
                rank?.peakTierId !== null && rank?.peakTierId !== undefined
                  ? resolveTierAsset(assets, rank.peakTierId)
                  : undefined;

              const maskedIdentity = p.isIncognito && !p.isSelf;
              const canClickProfile = !maskedIdentity && Boolean(p.gameName && p.tagLine);

              return (
                <tr
                  key={p.puuid}
                  className={`transition-colors duration-150 ${
                    p.isSelf ? "bg-white/[0.065]" : "hover:bg-white/[0.025]"
                  }`}
                >
                  <td className="py-3 pl-5 pr-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-0.5 h-7 rounded-full shrink-0 ${
                          p.isSelf ? "bg-[#ededed]" : "bg-transparent"
                        }`}
                      />
                      {agent?.displayIcon ? (
                        <img
                          src={agent.displayIcon}
                          alt={agent.displayName}
                          className={`w-8 h-8 rounded-[8px] object-cover border border-[rgba(255,255,255,0.09)] bg-black shrink-0 ${
                            isPregame && p.selectionState !== "locked" ? "opacity-60" : ""
                          }`}
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-[8px] border border-dashed border-[rgba(255,255,255,0.14)] bg-black flex items-center justify-center text-[10px] text-[#5c5c5c] shrink-0">
                          ?
                        </div>
                      )}

                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          {canClickProfile ? (
                            <button
                              type="button"
                              onClick={() => onSelectPlayer(p.gameName, p.tagLine)}
                              className="font-medium text-[#ededed] hover:underline truncate cursor-pointer text-left"
                            >
                              {p.gameName}
                              <span className="font-num text-[#8f8f8f] font-normal ml-0.5">
                                #{p.tagLine}
                              </span>
                            </button>
                          ) : (
                            <span className="text-[#8f8f8f] truncate">
                              {maskedIdentity
                                ? "匿名プレイヤー（非公開設定）"
                                : p.gameName || "Player"}
                            </span>
                          )}

                          {p.isSelf && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded border border-white/25 text-[#ededed] shrink-0">
                              YOU
                            </span>
                          )}
                        </div>

                        <div className="text-[11px] text-[#5c5c5c] flex items-center gap-1.5 mt-0.5">
                          <span>{agent?.displayName || "エージェント未確定"}</span>
                          {isPregame && (
                            <span className="text-[10px] text-[#8f8f8f]">
                              ({p.selectionState === "locked" ? "確定" : "選択中"})
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* Level */}
                  <td className="py-3 px-3 font-num text-[#8f8f8f]">
                    {p.hideAccountLevel && !p.isSelf ? "非公開" : `Lv. ${p.accountLevel}`}
                  </td>

                  {/* Current Rank */}
                  <td className="py-3 px-3">
                    {rank === undefined && isRanksLoading ? (
                      <div className="h-4 w-24 vt-skeleton" />
                    ) : effectiveTierId > 0 ? (
                      <div className="flex items-center gap-2">
                        {currentTierAsset?.smallIcon && (
                          <img
                            src={currentTierAsset.smallIcon}
                            alt=""
                            className="w-5 h-5 object-contain shrink-0"
                          />
                        )}
                        <div>
                          <div className="text-[#ededed] font-medium">
                            {currentTierAsset?.tierName || rank?.tierName || "ランクあり"}
                          </div>
                          {rank && (
                            <div className="font-num text-[11px] text-[#8f8f8f]">
                              {rank.rr} RR
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <span className="text-[#5c5c5c]">ランクなし</span>
                    )}
                  </td>

                  {/* Peak Rank */}
                  <td className="py-3 px-3">
                    {rank === undefined && isRanksLoading ? (
                      <div className="h-4 w-24 vt-skeleton" />
                    ) : rank?.peakTierId && rank.peakTierId > 0 ? (
                      <div className="flex items-center gap-2">
                        {peakTierAsset?.smallIcon && (
                          <img
                            src={peakTierAsset.smallIcon}
                            alt=""
                            className="w-5 h-5 object-contain shrink-0"
                          />
                        )}
                        <div>
                          <div className="text-[#8f8f8f]">
                            {peakTierAsset?.tierName || rank.peakTierName}
                          </div>
                          {rank.peakSeasonShort && (
                            <div className="font-num text-[10px] text-[#5c5c5c]">
                              {rank.peakSeasonShort}
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <span className="text-[#5c5c5c]">—</span>
                    )}
                  </td>

                  {/* K/D & HS% */}
                  <td className="py-3 px-3 text-right font-num">
                    {rank === undefined && isRanksLoading ? (
                      <div className="h-4 w-14 vt-skeleton ml-auto" />
                    ) : rank?.kd !== null && rank?.kd !== undefined ? (
                      <div>
                        <div
                          className={`font-semibold ${
                            rank.kd >= 1.2
                              ? "text-[var(--semantic-win)]"
                              : rank.kd >= 1.0
                                ? "text-[#ededed]"
                                : "text-[#8f8f8f]"
                          }`}
                        >
                          {rank.kd.toFixed(2)}
                        </div>
                        <div className="text-[11px] text-[#5c5c5c]">
                          {rank.hsPercent !== null
                            ? `HS ${rank.hsPercent.toFixed(0)}%`
                            : `${rank.kdSampleSize}戦`}
                        </div>
                      </div>
                    ) : (
                      <span className="text-[#5c5c5c]">—</span>
                    )}
                  </td>

                  {/* Season Winrate */}
                  <td className="py-3 pl-3 pr-5 text-right font-num">
                    {rank === undefined && isRanksLoading ? (
                      <div className="h-4 w-16 vt-skeleton ml-auto" />
                    ) : rank?.seasonWinRate !== null && rank?.seasonWinRate !== undefined ? (
                      <div>
                        <div className="text-[#ededed] font-medium">
                          {rank.seasonWinRate.toFixed(1)}%
                        </div>
                        <div className="text-[11px] text-[#5c5c5c]">
                          {rank.seasonWins}勝 / 計{rank.seasonGames}戦
                        </div>
                      </div>
                    ) : (
                      <span className="text-[#5c5c5c]">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface LiveMatchViewProps {
  defaultRegion: Region;
  apiKey: string;
  assets: ValorantAssetsCatalog;
  isActiveTab?: boolean;
  onSelectPlayer: (name: string, tag: string, region: Region) => void;
}

export function LiveMatchView({
  defaultRegion,
  apiKey,
  assets,
  isActiveTab = true,
  onSelectPlayer,
}: LiveMatchViewProps) {
  const initialCache = useRef(loadLastLiveCache());

  const [liveData, setLiveData] = useState<LiveMatchResponse | null>(
    () => initialCache.current.liveData,
  );
  const [ranksByPuuid, setRanksByPuuid] = useState<
    Record<string, LivePlayerRankInfo | undefined>
  >(() => initialCache.current.ranksByPuuid);

  const [savedTabs, setSavedTabs] = useState<SavedLiveMatchTab[]>(() =>
    loadSavedTabsFromStorage(),
  );
  // "live" = realtime tab, otherwise id of SavedLiveMatchTab
  const [selectedTabId, setSelectedTabId] = useState<string>("live");
  const [justSavedToast, setJustSavedToast] = useState(false);

  const [isLoading, setIsLoading] = useState(initialCache.current.liveData === null);
  const [isRanksLoading, setIsRanksLoading] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [errorText, setErrorText] = useState<string | null>(null);

  const fetchSeqRef = useRef(0);
  const ranksRef = useRef(ranksByPuuid);
  useEffect(() => {
    ranksRef.current = ranksByPuuid;
  }, [ranksByPuuid]);

  // Persist current live session cache whenever liveData or ranksByPuuid updates
  useEffect(() => {
    if (liveData) {
      saveLastLiveCache(liveData, ranksByPuuid);
    }
  }, [liveData, ranksByPuuid]);

  // Also keep any matching saved tab's player stats enriched if background rank fetches complete
  useEffect(() => {
    if (!liveData?.matchId) return;
    setSavedTabs((prev) => {
      const idx = prev.findIndex((t) => t.matchId && t.matchId === liveData.matchId);
      if (idx < 0) return prev;
      const target = prev[idx];
      const mergedRanks = { ...target.ranksByPuuid };
      let changed = false;
      for (const p of target.liveData.players) {
        const k = p.puuid.toLowerCase();
        if (!mergedRanks[k] && ranksByPuuid[k]) {
          mergedRanks[k] = ranksByPuuid[k];
          changed = true;
        }
      }
      if (!changed) return prev;
      const next = [...prev];
      next[idx] = { ...target, ranksByPuuid: mergedRanks };
      saveTabsToStorage(next);
      return next;
    });
  }, [liveData, ranksByPuuid]);

  const loadLiveMatch = useCallback(
    async (options?: { manual?: boolean }) => {
      const seq = ++fetchSeqRef.current;
      if (options?.manual || !liveData) {
        setIsLoading(true);
      }
      setErrorText(null);

      try {
        const resp = await fetchLiveMatchFromClient(defaultRegion);
        if (seq !== fetchSeqRef.current) return;
        setLiveData(resp);
        setIsLoading(false);

        if ((resp.status === "IN_GAME" || resp.status === "PREGAME") && resp.players.length > 0) {
          const effectiveRegion = normalizeRegion(resp.detectedRegion, defaultRegion);

          // Only fetch players we haven't already resolved (unless manual refresh was clicked)
          const toFetch = options?.manual
            ? resp.players
            : resp.players.filter((p) => ranksRef.current[p.puuid.toLowerCase()] === undefined);

          if (toFetch.length === 0) {
            setIsRanksLoading(false);
            return;
          }

          setIsRanksLoading(true);
          const batchSize = 3;
          for (let i = 0; i < toFetch.length; i += batchSize) {
            if (seq !== fetchSeqRef.current) return;
            const slice = toFetch.slice(i, i + batchSize);
            const results = await Promise.all(
              slice.map(async (p) => {
                const info = await fetchPlayerRankByPuuid(p.puuid, effectiveRegion, apiKey);
                return [p.puuid.toLowerCase(), info ?? undefined] as const;
              }),
            );
            if (seq !== fetchSeqRef.current) return;
            setRanksByPuuid((prev) => {
              const next = { ...prev };
              for (const [k, v] of results) {
                if (v) next[k] = v;
              }
              return next;
            });
          }
          if (seq === fetchSeqRef.current) {
            setIsRanksLoading(false);
          }
        } else {
          setIsRanksLoading(false);
        }
      } catch (err) {
        if (seq !== fetchSeqRef.current) return;
        setErrorText(err instanceof Error ? err.message : String(err));
        setIsLoading(false);
      }
    },
    [apiKey, defaultRegion, liveData],
  );

  // Initial load once on mount
  const didInitRef = useRef(false);
  useEffect(() => {
    if (!didInitRef.current) {
      didInitRef.current = true;
      void loadLiveMatch();
    }
  }, [loadLiveMatch]);

  // Silent background auto-refresh when on the realtime tab & LiveMatchView is visible
  useEffect(() => {
    if (!autoRefresh || !isActiveTab || selectedTabId !== "live") return;
    const timer = window.setInterval(() => {
      void loadLiveMatch();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, isActiveTab, selectedTabId, loadLiveMatch]);

  // Save / Update Current Match as a Persistent Sub-Tab
  const handleSaveCurrentMatchTab = () => {
    if (!liveData || (liveData.status !== "IN_GAME" && liveData.status !== "PREGAME")) return;
    const region = normalizeRegion(liveData.detectedRegion, defaultRegion);
    const mAsset = liveData.mapUrl ? resolveMapAsset(assets, null, liveData.mapUrl) : undefined;
    const mName = mAsset?.displayName || liveData.mapUrl?.split("/").pop() || "マッチ";
    const now = Date.now();
    const d = new Date(now);
    const timeStr = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(
      2,
      "0",
    )}`;
    const label = `${mName} (${timeStr})`;

    setSavedTabs((prev) => {
      const existingIdx = liveData.matchId
        ? prev.findIndex((t) => t.matchId === liveData.matchId)
        : -1;

      let next: SavedLiveMatchTab[];
      let focusId: string;
      if (existingIdx >= 0) {
        focusId = prev[existingIdx].id;
        next = [...prev];
        next[existingIdx] = {
          ...prev[existingIdx],
          label,
          savedAt: now,
          region,
          liveData,
          ranksByPuuid: { ...prev[existingIdx].ranksByPuuid, ...ranksByPuuid },
        };
      } else {
        focusId = `saved-${liveData.matchId || now}`;
        const newTab: SavedLiveMatchTab = {
          id: focusId,
          matchId: liveData.matchId,
          label,
          savedAt: now,
          region,
          liveData,
          ranksByPuuid: { ...ranksByPuuid },
        };
        next = [newTab, ...prev].slice(0, MAX_SAVED_TABS);
      }

      saveTabsToStorage(next);
      setSelectedTabId(focusId);
      return next;
    });

    setJustSavedToast(true);
    window.setTimeout(() => setJustSavedToast(false), 2200);
  };

  const handleRemoveSavedTab = (tabId: string) => {
    setSavedTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      saveTabsToStorage(next);
      return next;
    });
    if (selectedTabId === tabId) {
      setSelectedTabId("live");
    }
  };

  const activeSavedTab =
    selectedTabId === "live"
      ? null
      : (savedTabs.find((t) => t.id === selectedTabId) ?? null);

  const viewData = activeSavedTab ? activeSavedTab.liveData : liveData;
  const viewRanks = activeSavedTab ? activeSavedTab.ranksByPuuid : ranksByPuuid;
  const status = viewData?.status ?? "NOT_RUNNING";
  const isActiveMatch = status === "IN_GAME" || status === "PREGAME";
  const effectiveRegion = activeSavedTab
    ? activeSavedTab.region
    : normalizeRegion(viewData?.detectedRegion, defaultRegion);

  const mapAsset = viewData?.mapUrl ? resolveMapAsset(assets, null, viewData.mapUrl) : undefined;
  const mapLabel = mapAsset?.displayName || viewData?.mapUrl?.split("/").pop() || "マップ未確定";
  const modeLabel = formatLiveModeLabel(viewData?.modeId, viewData?.queueId);

  const allies = (viewData?.players ?? []).filter((p) => p.isAlly);
  const enemies = (viewData?.players ?? []).filter((p) => !p.isAlly);

  const canSaveLiveNow =
    selectedTabId === "live" &&
    Boolean(liveData && (liveData.status === "IN_GAME" || liveData.status === "PREGAME"));

  const isCurrentMatchAlreadySaved = Boolean(
    liveData?.matchId && savedTabs.some((t) => t.matchId === liveData.matchId),
  );

  return (
    <div className="max-w-5xl mx-auto py-8 px-6 space-y-6 vt-animate-in">
      {/* Persistent Sub-Tab Bar: Realtime + Saved Match Tabs */}
      <div className="flex items-center justify-between gap-3 vt-hairline-b pb-3 overflow-x-auto">
        <div className="flex items-center gap-1.5 min-w-0">
          <button
            type="button"
            onClick={() => setSelectedTabId("live")}
            className={`h-8 px-3 rounded-[9px] text-xs flex items-center gap-2 shrink-0 transition-colors cursor-pointer border ${
              selectedTabId === "live"
                ? "bg-[#ededed] text-[#0a0a0a] border-[#ededed] font-medium"
                : "bg-[#0d0d0d] text-[#8f8f8f] border-[rgba(255,255,255,0.09)] hover:text-[#ededed]"
            }`}
          >
            <Radio className="w-3.5 h-3.5" />
            <span>リアルタイム</span>
          </button>

          {savedTabs.map((tab) => {
            const active = selectedTabId === tab.id;
            return (
              <div
                key={tab.id}
                className={`h-8 pl-3 pr-1.5 rounded-[9px] text-xs flex items-center gap-1.5 shrink-0 transition-colors border ${
                  active
                    ? "bg-white/[0.11] text-[#ededed] border-white/25 font-medium"
                    : "bg-[#0d0d0d] text-[#8f8f8f] border-[rgba(255,255,255,0.09)] hover:text-[#ededed]"
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSelectedTabId(tab.id)}
                  className="flex items-center gap-1.5 cursor-pointer"
                >
                  <Bookmark className="w-3 h-3 text-[#8f8f8f]" />
                  <span>{tab.label}</span>
                </button>
                <button
                  type="button"
                  title="保存タブを閉じる"
                  onClick={() => handleRemoveSavedTab(tab.id)}
                  className="p-1 rounded hover:bg-white/[0.12] text-[#5c5c5c] hover:text-[#ededed] cursor-pointer"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            );
          })}
        </div>

        {canSaveLiveNow && (
          <button
            type="button"
            onClick={handleSaveCurrentMatchTab}
            className="h-8 px-3 rounded-[9px] bg-[#141414] hover:bg-[#1e1e1e] text-[#ededed] text-xs vt-hairline flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer"
          >
            {justSavedToast ? (
              <>
                <Check className="w-3.5 h-3.5 text-[var(--semantic-win)]" />
                <span>タブ保存しました</span>
              </>
            ) : (
              <>
                <Bookmark className="w-3.5 h-3.5" />
                <span>
                  {isCurrentMatchAlreadySaved ? "保存タブを更新" : "この試合をタブ保存"}
                </span>
              </>
            )}
          </button>
        )}
      </div>

      {/* Top Control Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-xl font-semibold tracking-tight text-[#ededed]">
              {activeSavedTab ? `保存済みマッチ: ${activeSavedTab.label}` : "ライブマッチ（試合中情報）"}
            </h1>

            {activeSavedTab ? (
              <span className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-0.5 rounded-full border border-white/20 bg-white/[0.06] text-[#ededed] font-num">
                <Clock className="w-3 h-3 text-[#8f8f8f]" />
                {formatSavedTime(activeSavedTab.savedAt)} 保存
              </span>
            ) : (
              <span
                className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-0.5 rounded-full border ${
                  status === "IN_GAME"
                    ? "text-[var(--semantic-win)] border-[var(--semantic-win-border)] bg-[var(--semantic-win-bg)]"
                    : status === "PREGAME"
                      ? "text-[#ededed] border-white/25 bg-white/[0.07]"
                      : "text-[#8f8f8f] border-[rgba(255,255,255,0.09)]"
                }`}
              >
                <Radio className="w-3 h-3" />
                {status === "IN_GAME"
                  ? "試合進行中"
                  : status === "PREGAME"
                    ? "エージェント選択中"
                    : status === "IN_MENU"
                      ? "ロビー待機中"
                      : "未接続"}
              </span>
            )}
          </div>
          <p className="text-xs text-[#8f8f8f] mt-1">
            {activeSavedTab
              ? "保存した試合スナップショットを表示しています。別のタブへ移動しても状態はそのまま保持されます。"
              : "起動中の VALORANT クライアントから現在のマッチ参加者とランク・K/D を自動検出します（タブ切替時も取得済みデータを保持）。"}
          </p>
        </div>

        {!activeSavedTab && (
          <div className="flex items-center gap-2.5 self-start sm:self-center">
            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              className={`h-9 px-3.5 text-xs rounded-[12px] border transition-colors duration-150 cursor-pointer ${
                autoRefresh
                  ? "bg-white/[0.07] border-white/25 text-[#ededed]"
                  : "bg-[#0a0a0a] border-[rgba(255,255,255,0.09)] text-[#8f8f8f] hover:text-[#ededed]"
              }`}
            >
              自動更新 (15秒): {autoRefresh ? "ON" : "OFF"}
            </button>

            <button
              type="button"
              onClick={() => void loadLiveMatch({ manual: true })}
              disabled={isLoading}
              className="inline-flex items-center gap-1.5 h-9 px-4 text-xs font-medium rounded-[12px] bg-[#ededed] text-black hover:bg-white transition-colors duration-150 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
              <span>再取得</span>
            </button>
          </div>
        )}
      </div>

      {errorText && !activeSavedTab && (
        <div className="vt-panel p-5 flex items-center gap-3 text-xs text-[var(--semantic-loss)]">
          <ShieldAlert className="w-4 h-4 shrink-0" />
          <span>{errorText}</span>
        </div>
      )}

      {!isActiveMatch ? (
        <div className="vt-panel p-10 text-center space-y-3">
          <div className="w-10 h-10 mx-auto rounded-[12px] border border-[rgba(255,255,255,0.09)] bg-black flex items-center justify-center">
            <Radio className="w-4 h-4 text-[#8f8f8f]" />
          </div>
          <div className="text-sm font-medium text-[#ededed]">
            {status === "IN_MENU" ? "マッチ待機中" : "VALORANT が起動していません"}
          </div>
          <p className="text-xs text-[#8f8f8f] max-w-md mx-auto leading-relaxed">
            {viewData?.message ||
              "VALORANT を起動してマッチ（エージェント選択または試合中）に入ると、自動的に全プレイヤーのランク・K/D・勝率が表示されます。"}
          </p>
          {savedTabs.length > 0 && (
            <p className="text-[11px] text-[#5c5c5c] pt-1">
              上部の保存済みタブから過去の試合ロビーをいつでも確認できます。
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {/* Active Match Banner */}
          <div className="vt-panel relative overflow-hidden p-6">
            {mapAsset?.splash && (
              <div className="absolute inset-0 pointer-events-none opacity-[0.14]">
                <img
                  src={mapAsset.splash}
                  alt=""
                  className="w-full h-full object-cover object-center"
                />
                <div className="absolute inset-0 bg-gradient-to-r from-[#0a0a0a] via-[#0a0a0a]/85 to-[#0a0a0a]/55" />
              </div>
            )}

            <div className="relative flex flex-wrap items-center justify-between gap-4">
              <div>
                <div className="flex items-center gap-2.5">
                  <h2 className="text-lg font-semibold text-[#ededed]">{mapLabel}</h2>
                  <span className="text-xs px-2.5 py-0.5 rounded-full border border-[rgba(255,255,255,0.09)] bg-black/60 text-[#8f8f8f]">
                    {modeLabel}
                  </span>
                </div>

                <div className="flex items-center gap-3 text-xs text-[#8f8f8f] mt-1.5">
                  {viewData?.serverPod && (
                    <span className="inline-flex items-center gap-1 font-num">
                      <Server className="w-3.5 h-3.5 text-[#5c5c5c]" />
                      {viewData.serverPod}
                    </span>
                  )}
                  <span className="font-num uppercase text-[#5c5c5c]">
                    REGION: {effectiveRegion}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Ally Team */}
          {allies.length > 0 && (
            <LiveTeamTable
              title="味方チーム"
              isAllyTable={true}
              players={allies}
              ranksByPuuid={viewRanks}
              isRanksLoading={!activeSavedTab && isRanksLoading}
              isPregame={status === "PREGAME"}
              assets={assets}
              onSelectPlayer={(n, t) => onSelectPlayer(n, t, effectiveRegion)}
            />
          )}

          {/* Enemy Team */}
          {enemies.length > 0 && (
            <LiveTeamTable
              title="相手チーム"
              isAllyTable={false}
              players={enemies}
              ranksByPuuid={viewRanks}
              isRanksLoading={!activeSavedTab && isRanksLoading}
              isPregame={status === "PREGAME"}
              assets={assets}
              onSelectPlayer={(n, t) => onSelectPlayer(n, t, effectiveRegion)}
            />
          )}
        </div>
      )}
    </div>
  );
}

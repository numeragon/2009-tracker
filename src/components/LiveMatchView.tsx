import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Bookmark,
  Check,
  Clock,
  Loader2,
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
  PlayerLoadoutResponse,
  Region,
  StoreCatalog,
  ValorantAssetsCatalog,
} from "../types/valorant";
import {
  fetchLiveMatchFromClient,
  fetchPlayerLoadout,
  fetchPlayerRankByPuuid,
  formatLiveModeLabel,
  normalizeRegion,
} from "../lib/liveMatchApi";
import {
  buildPlayerCardUrls,
  resolveAgentAsset,
  resolveMapAsset,
  resolveTierAsset,
} from "../lib/valorantAssets";
import { loadStoreCatalog, resolveStoreSkin } from "../lib/storeCatalog";

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
  onHoverPlayer?: (
    player: LiveMatchPlayerRaw,
    name: string,
    tag: string,
    element: HTMLElement,
  ) => void;
  onLeavePlayer?: () => void;
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
  onHoverPlayer,
  onLeavePlayer,
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

              const isMasked = p.isIncognito && !p.isSelf;
              // Incognito rosters expose a placeholder such as "Player" or
              // "Player 3". The stats API is keyed by PUUID, so it still knows
              // the real Riot ID and we can show it instead.
              const placeholderName =
                !p.gameName || /^player[\s_-]*\d*$/i.test(p.gameName.trim());
              const revealedName =
                (placeholderName || p.isIncognito) && rank?.accountName
                  ? rank.accountName
                  : null;
              const revealedTag = revealedName
                ? rank?.accountTag || p.tagLine
                : "";
              const displayName = revealedName ?? p.gameName;
              const displayTag = revealedName ? revealedTag : p.tagLine;
              const canClickProfile = Boolean(displayName && displayTag);

              return (
                <tr
                  key={p.puuid}
                  className={`transition-colors duration-150 ${
                    p.isSelf ? "bg-white/[0.065]" : "hover:bg-white/[0.025]"
                  }`}
                >
                  <td
                    className="py-3 pl-5 pr-3"
                    onMouseEnter={(event) =>
                      onHoverPlayer?.(
                        p,
                        displayName || "Player",
                        displayTag,
                        event.currentTarget,
                      )
                    }
                    onMouseLeave={() => onLeavePlayer?.()}
                  >
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

                      <div className="min-w-0" data-player-name>
                        <div className="flex items-center gap-1.5">
                          {canClickProfile ? (
                            <button
                              type="button"
                              onClick={() => onSelectPlayer(displayName, displayTag)}
                              className="font-medium text-[#ededed] hover:underline truncate cursor-pointer text-left"
                              title={isMasked ? "匿名設定のプレイヤー（名前を解決）" : undefined}
                            >
                              {displayName}
                              <span className="font-num text-[#8f8f8f] font-normal ml-0.5">
                                #{displayTag}
                              </span>
                            </button>
                          ) : (
                            <span className="text-[#8f8f8f] truncate">
                              {displayName || "Player"}
                            </span>
                          )}

                          {isMasked && (
                            <span
                              title={
                                canClickProfile
                                  ? "ゲーム内では匿名設定ですが、PUUIDから名前を解決しています"
                                  : "匿名設定のプレイヤーです。名前を解決できませんでした"
                              }
                              className="text-[9px] px-1 py-0.2 rounded border border-[rgba(255,255,255,0.16)] text-[#8f8f8f] shrink-0"
                            >
                              {canClickProfile ? "匿名解除" : "匿名"}
                            </span>
                          )}

                          {p.isSelf && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded border border-white/25 text-[#ededed] shrink-0">
                              YOU
                            </span>
                          )}

                          {p.isPartyOwner && (
                            <span className="text-[9px] px-1 py-0.2 rounded border border-[rgba(255,255,255,0.16)] text-[#8f8f8f] shrink-0">
                              リーダー
                            </span>
                          )}

                          {p.partyReady === true && (
                            <span className="text-[9px] px-1 py-0.2 rounded border border-[var(--semantic-win-border)] text-[var(--semantic-win)] shrink-0">
                              準備完了
                            </span>
                          )}

                          {p.partyReady === false && (
                            <span className="text-[9px] px-1 py-0.2 rounded border border-[rgba(255,255,255,0.12)] text-[#5c5c5c] shrink-0">
                              未準備
                            </span>
                          )}
                        </div>

                        <div className="text-[11px] text-[#5c5c5c] flex items-center gap-1.5 mt-0.5">
                          <span>
                            {agent?.displayName ||
                              (isPregame ? "エージェント未確定" : "パーティメンバー")}
                          </span>
                          {isPregame && (
                            <span className="text-[10px] text-[#8f8f8f]">
                              ({p.selectionState === "locked"
                                ? "確定"
                                : p.agentId
                                  ? "選択中"
                                  : "未選択"})
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

interface LockerAnchor {
  player: LiveMatchPlayerRaw;
  name: string;
  tag: string;
  left: number;
  /** Viewport top of the hovered row. */
  top: number;
  /** Viewport bottom of the hovered row. */
  bottom: number;
  placement: "below" | "above";
}

const LOCKER_WIDTH = 430;

/**
 * Hover card that mirrors the in-game locker: the player's equipped skin for
 * every gun, with the weapon name underneath.
 */
function PlayerLockerTooltip({
  anchor,
  region,
  assets,
}: {
  anchor: LockerAnchor;
  region: Region;
  assets: ValorantAssetsCatalog;
}) {
  const [loadout, setLoadout] = useState<PlayerLoadoutResponse | null>(null);
  const [catalog, setCatalog] = useState<StoreCatalog | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPlayerLoadout(anchor.player.puuid, region).then((result) => {
      if (!cancelled) setLoadout(result);
    });
    return () => {
      cancelled = true;
    };
  }, [anchor.player.puuid, region]);

  useEffect(() => {
    let cancelled = false;
    void loadStoreCatalog().then((loaded) => {
      if (!cancelled) setCatalog(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const width = Math.max(300, Math.min(LOCKER_WIDTH, window.innerWidth - 24));
  const left = Math.min(
    Math.max(12, anchor.left),
    Math.max(12, window.innerWidth - width - 12),
  );
  const vertical =
    anchor.placement === "below"
      ? { top: anchor.bottom + 8 }
      : { bottom: window.innerHeight - anchor.top + 8 };
  const available =
    anchor.placement === "below"
      ? window.innerHeight - anchor.bottom - 20
      : anchor.top - 20;
  const maxHeight = Math.max(180, Math.min(430, available));
  const card = buildPlayerCardUrls(loadout?.cardId ?? undefined);

  return createPortal(
    <div
      className="fixed z-[90] pointer-events-none vt-animate-in"
      style={{ left, width, maxHeight, ...vertical }}
    >
      <div className="flex max-h-full flex-col overflow-hidden rounded-[12px] border border-[rgba(255,255,255,0.1)] bg-[#0a0a0a] shadow-[0_24px_64px_rgba(0,0,0,0.75)]">
        <div className="relative h-[68px] shrink-0 border-b border-[rgba(255,255,255,0.07)] bg-black">
          {card.wide && (
            <img
              src={card.wide}
              alt=""
              className="absolute inset-0 h-full w-full object-cover opacity-30"
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/45 to-black/10" />
          <div className="relative flex h-full flex-col justify-center px-4">
            <p className="text-[9px] uppercase tracking-[0.24em] text-[#5c5c5c]">
              Player Loadout
            </p>
            <p className="truncate text-[13px] font-medium text-[#ededed]">
              {anchor.name}
              {anchor.tag && (
                <span className="ml-0.5 font-num font-normal text-[#8f8f8f]">
                  #{anchor.tag}
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col p-3">
          {!loadout ? (
            <div className="flex h-24 items-center justify-center gap-2 text-[11px] text-[#8f8f8f]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ロッカーを読み込み中…
            </div>
          ) : !loadout.ok ? (
            <p className="px-1 py-3 text-[11px] leading-relaxed text-[#8f8f8f]">
              {loadout.message ?? "ロッカーを取得できませんでした。"}
            </p>
          ) : loadout.guns.length === 0 ? (
            <p className="px-1 py-3 text-[11px] text-[#8f8f8f]">
              装備情報が見つかりませんでした。
            </p>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-3 gap-2 overflow-y-auto pr-1">
              {loadout.guns.map((gun) => {
                const weapon = assets.weaponsById[gun.weaponId.toLowerCase()];
                const skin = catalog
                  ? resolveStoreSkin(
                      catalog,
                      gun.skinLevelId ?? gun.skinId ?? "",
                    )
                  : undefined;
                const skinName = skin?.name ?? "デフォルト";
                const weaponName = weapon?.displayName ?? "";
                const icon = skin?.icon || weapon?.displayIcon || "";
                return (
                  <div
                    key={gun.weaponId}
                    className="rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-black/60 p-2"
                  >
                    <div className="flex h-14 items-center justify-center">
                      {icon ? (
                        <img
                          src={icon}
                          alt=""
                          loading="lazy"
                          className="max-h-14 max-w-full object-contain"
                        />
                      ) : (
                        <span className="text-[10px] text-[#3a3a3a]">—</span>
                      )}
                    </div>
                    <p
                      className="mt-1.5 truncate text-[10px] text-[#ededed]"
                      title={skinName}
                    >
                      {skinName}
                    </p>
                    <p
                      className="truncate text-[9px] text-[#5c5c5c]"
                      title={weaponName}
                    >
                      {weaponName || "武器"}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
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
  const [lockerAnchor, setLockerAnchor] = useState<LockerAnchor | null>(null);

  const lockerHideTimer = useRef<number | null>(null);
  const showLocker = useCallback(
    (
      player: LiveMatchPlayerRaw,
      name: string,
      tag: string,
      element: HTMLElement,
    ) => {
      if (lockerHideTimer.current !== null) {
        window.clearTimeout(lockerHideTimer.current);
        lockerHideTimer.current = null;
      }
      const rect = (
        element.querySelector<HTMLElement>("[data-player-name]") ?? element
      ).getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom - 20;
      const spaceAbove = rect.top - 20;
      const placement: "below" | "above" =
        spaceBelow >= 360 || spaceBelow >= spaceAbove ? "below" : "above";
      setLockerAnchor({
        player,
        name,
        tag,
        left: rect.left,
        top: rect.top,
        bottom: rect.bottom,
        placement,
      });
    },
    [],
  );
  const hideLocker = useCallback(() => {
    if (lockerHideTimer.current !== null) {
      window.clearTimeout(lockerHideTimer.current);
    }
    lockerHideTimer.current = window.setTimeout(() => {
      setLockerAnchor(null);
      lockerHideTimer.current = null;
    }, 120);
  }, []);
  useEffect(
    () => () => {
      if (lockerHideTimer.current !== null) {
        window.clearTimeout(lockerHideTimer.current);
      }
    },
    [],
  );

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

        if ((resp.status === "IN_GAME" || resp.status === "PREGAME" || resp.status === "IN_MENU") && resp.players.length > 0) {
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
  const isLobby = status === "IN_MENU" && (viewData?.players.length ?? 0) > 0;
  const hasRoster = isActiveMatch || isLobby;
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
        <div className="min-w-0">
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
              : "起動中の VALORANT クライアントから、ロビーのパーティメンバーやマッチ参加者とランク・K/D を自動検出します（タブ切替時も取得済みデータを保持）。"}
          </p>
        </div>

        {!activeSavedTab && (
          <div className="flex items-center gap-2.5 self-start sm:self-center shrink-0">
            <button
              type="button"
              onClick={() => setAutoRefresh((v) => !v)}
              className={`h-9 px-3.5 text-xs rounded-[12px] border transition-colors duration-150 cursor-pointer whitespace-nowrap ${
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
              className="inline-flex items-center gap-1.5 h-9 px-4 text-xs font-medium rounded-[12px] bg-[#ededed] text-black hover:bg-white transition-colors duration-150 disabled:opacity-50 cursor-pointer whitespace-nowrap"
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

      {!hasRoster ? (
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
          {isLobby ? (
            <div className="vt-panel relative overflow-hidden p-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h2 className="text-lg font-semibold text-[#ededed]">
                      パーティロビー
                    </h2>
                    <span className="text-xs px-2.5 py-0.5 rounded-full border border-[rgba(255,255,255,0.09)] bg-black/60 text-[#8f8f8f]">
                      {modeLabel}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-[#8f8f8f] mt-1.5">
                    <span className="font-num">{allies.length} 人</span>
                    <span className="font-num uppercase text-[#5c5c5c]">
                      REGION: {effectiveRegion}
                    </span>
                  </div>
                </div>

                <span className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-0.5 rounded-full border border-white/25 bg-white/[0.07] text-[#ededed]">
                  <Radio className="w-3 h-3" />
                  ロビー待機中
                </span>
              </div>
            </div>
          ) : (
          /* Active Match Banner */
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
                  {status === "PREGAME" && viewData?.allySide && (
                    <span
                      className={`text-xs px-2.5 py-0.5 rounded-full border font-medium ${
                        viewData.allySide === "attack"
                          ? "border-[var(--semantic-loss-border)] bg-[var(--semantic-loss-bg)] text-[var(--semantic-loss)]"
                          : "border-[var(--semantic-win-border)] bg-[var(--semantic-win-bg)] text-[var(--semantic-win)]"
                      }`}
                    >
                      前半: {viewData.allySide === "attack" ? "攻撃" : "防御"}
                    </span>
                  )}
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
          )}

          {/* Pregame: enemy picks */}
          {status === "PREGAME" && enemies.length > 0 && (
            <section className="vt-panel overflow-hidden">
              <div className="px-5 py-3.5 flex items-center justify-between vt-hairline-b bg-[#0a0a0a]">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-xs font-medium text-[#ededed]">相手のピック</h2>
                  <span className="text-[10px] text-[#5c5c5c]">エージェント選択中</span>
                </div>
                <span className="font-num text-[10px] uppercase text-[#5c5c5c]">
                  {enemies.filter((p) => p.agentId).length} / {enemies.length} picked
                </span>
              </div>

              <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                {enemies.map((p) => {
                  const agent = p.agentId
                    ? resolveAgentAsset(assets, p.agentId, null)
                    : undefined;
                  const stateLabel =
                    p.selectionState === "locked"
                      ? "確定"
                      : p.agentId
                        ? "選択中"
                        : "未選択";
                  return (
                    <div
                      key={p.puuid}
                      className="rounded-[10px] border border-[rgba(255,255,255,0.08)] bg-black px-3 py-2.5 flex items-center gap-2.5 min-w-0"
                    >
                      {agent?.displayIcon ? (
                        <img
                          src={agent.displayIcon}
                          alt={agent.displayName}
                          className={`w-9 h-9 rounded-[8px] object-cover border border-[rgba(255,255,255,0.09)] bg-black shrink-0 ${
                            p.selectionState !== "locked" ? "opacity-55" : ""
                          }`}
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-[8px] border border-dashed border-[rgba(255,255,255,0.14)] flex items-center justify-center text-[10px] text-[#5c5c5c] shrink-0">
                          ?
                        </div>
                      )}
                      <div className="min-w-0">
                        <div className="text-[11px] text-[#ededed] truncate">
                          {agent?.displayName || "未選択"}
                        </div>
                        <div className="text-[10px] text-[#5c5c5c] truncate">
                          {p.gameName}
                          <span className="font-num">#{p.tagLine}</span>
                        </div>
                        <div className="text-[9px] mt-0.5 text-[#8f8f8f]">{stateLabel}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Ally Team / Party lobby */}
          {allies.length > 0 && (
            <LiveTeamTable
              title={isLobby ? "パーティ（ロビー）" : "味方チーム"}
              isAllyTable={true}
              players={allies}
              ranksByPuuid={viewRanks}
              isRanksLoading={!activeSavedTab && isRanksLoading}
              isPregame={status === "PREGAME"}
              assets={assets}
              onSelectPlayer={(n, t) => onSelectPlayer(n, t, effectiveRegion)}
              onHoverPlayer={showLocker}
              onLeavePlayer={hideLocker}
            />
          )}

          {/* Enemy Team */}
          {!isLobby && enemies.length > 0 && (
            <LiveTeamTable
              title="相手チーム"
              isAllyTable={false}
              players={enemies}
              ranksByPuuid={viewRanks}
              isRanksLoading={!activeSavedTab && isRanksLoading}
              isPregame={status === "PREGAME"}
              assets={assets}
              onSelectPlayer={(n, t) => onSelectPlayer(n, t, effectiveRegion)}
              onHoverPlayer={showLocker}
              onLeavePlayer={hideLocker}
            />
          )}
        </div>
      )}

      {lockerAnchor && (
        <PlayerLockerTooltip
          key={`${lockerAnchor.player.puuid}:${lockerAnchor.placement}`}
          anchor={lockerAnchor}
          region={effectiveRegion}
          assets={assets}
        />
      )}
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Crown,
  EyeOff,
  ExternalLink,
  Hash,
  Pin,
  RefreshCw,
  Search,
  Trophy,
  X,
} from "lucide-react";
import type {
  LeaderboardLookupResult,
  LeaderboardPlayerItem,
  LeaderboardSliceBundle,
  Region,
  SavedPlayerEntry,
  ValorantAssetsCatalog,
} from "../types/valorant";
import { ApiClientError, normalizeError } from "../lib/errors";
import { fetchLeaderboardSlice, lookupLeaderboardPlayer } from "../lib/henrikApi";
import { playerKey } from "../lib/storage";
import { resolveTierAsset } from "../lib/valorantAssets";
import { ErrorBanner } from "./ErrorBanner";

interface LeaderboardViewProps {
  defaultRegion: Region;
  apiKey: string;
  assets: ValorantAssetsCatalog;
  favorites: SavedPlayerEntry[];
  history: SavedPlayerEntry[];
  onSelectPlayer: (name: string, tag: string, region: Region) => void;
  onOpenSettings: () => void;
}

const REGIONS: Array<{ id: Region; code: string; label: string }> = [
  { id: "ap", code: "AP", label: "アジアパシフィック" },
  { id: "kr", code: "KR", label: "韓国" },
  { id: "na", code: "NA", label: "北米" },
  { id: "eu", code: "EU", label: "ヨーロッパ" },
  { id: "br", code: "BR", label: "ブラジル" },
  { id: "latam", code: "LATAM", label: "ラテンアメリカ" },
];

const PAGE_SIZE = 100;
const CHUNK_SIZE = 1000;

function formatUpdatedTime(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")} 更新`;
}

export function LeaderboardView({
  defaultRegion,
  apiKey,
  assets,
  favorites,
  history,
  onSelectPlayer,
  onOpenSettings,
}: LeaderboardViewProps) {
  const [lbRegion, setLbRegion] = useState<Region>(defaultRegion);
  const [page, setPage] = useState(1); // 1-based page (100 rows per page)
  const [chunks, setChunks] = useState<Record<number, LeaderboardSliceBundle>>({});
  const [metaSlice, setMetaSlice] = useState<LeaderboardSliceBundle | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiClientError | null>(null);

  // Filter / Player Rank Lookup state
  const [queryInput, setQueryInput] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResult, setLookupResult] = useState<LeaderboardLookupResult | null>(null);
  const [lookupError, setLookupError] = useState<ApiClientError | null>(null);
  const [highlightRank, setHighlightRank] = useState<number | null>(null);

  // Rank jump input
  const [rankJumpInput, setRankJumpInput] = useState("");

  const reqIdRef = useRef(0);

  const chunkStartForPage = (targetPage: number): number => {
    const zeroBasedRow = Math.max(0, (targetPage - 1) * PAGE_SIZE);
    return Math.floor(zeroBasedRow / CHUNK_SIZE) * CHUNK_SIZE;
  };

  const loadChunk = useCallback(
    async (
      region: Region,
      chunkStart: number,
      options?: { forceRefresh?: boolean; resetChunks?: boolean },
    ) => {
      const reqId = ++reqIdRef.current;
      setIsLoading(true);
      setError(null);

      try {
        const bundle = await fetchLeaderboardSlice(region, apiKey, {
          startIndex: chunkStart,
          size: CHUNK_SIZE,
          forceRefresh: options?.forceRefresh,
        });
        if (reqId !== reqIdRef.current) return;

        setMetaSlice(bundle);
        setChunks((prev) =>
          options?.resetChunks
            ? { [chunkStart]: bundle }
            : { ...prev, [chunkStart]: bundle },
        );
      } catch (err) {
        if (reqId !== reqIdRef.current) return;
        setError(normalizeError(err));
      } finally {
        if (reqId === reqIdRef.current) {
          setIsLoading(false);
        }
      }
    },
    [apiKey],
  );

  // Reload when region changes
  useEffect(() => {
    setPage(1);
    setChunks({});
    setLookupResult(null);
    setLookupError(null);
    setHighlightRank(null);
    void loadChunk(lbRegion, 0, { resetChunks: true });
  }, [lbRegion, loadChunk]);

  // Ensure chunk for current page is loaded
  useEffect(() => {
    const wantChunk = chunkStartForPage(page);
    if (!chunks[wantChunk] && !isLoading && !error) {
      void loadChunk(lbRegion, wantChunk);
    }
  }, [page, chunks, isLoading, error, lbRegion, loadChunk]);

  const totalPlayers = metaSlice?.totalPlayers ?? 15000;
  const totalPages = Math.max(1, Math.ceil(totalPlayers / PAGE_SIZE));

  const currentChunkStart = chunkStartForPage(page);
  const activeChunk = chunks[currentChunkStart] ?? null;

  // All loaded players across fetched chunks (sorted by rank) for instant text filtering
  const allLoadedPlayers = useMemo(() => {
    const list: LeaderboardPlayerItem[] = [];
    const keys = Object.keys(chunks)
      .map(Number)
      .sort((a, b) => a - b);
    for (const k of keys) {
      list.push(...(chunks[k]?.players ?? []));
    }
    return list;
  }, [chunks]);

  const trimmedQuery = queryInput.trim();
  const hasHashTag = trimmedQuery.includes("#") || trimmedQuery.includes("＃");

  const filteredPlayers = useMemo(() => {
    if (!trimmedQuery) return null;
    const normalized = trimmedQuery.replace(/＃/g, "#").toLowerCase();
    return allLoadedPlayers.filter((p) => {
      if (p.isAnonymized) return false;
      const full = `${p.name}#${p.tag}`.toLowerCase();
      return (
        full.includes(normalized) ||
        p.name.toLowerCase().includes(normalized) ||
        p.tag.toLowerCase().includes(normalized)
      );
    });
  }, [allLoadedPlayers, trimmedQuery]);

  const pagePlayers = useMemo(() => {
    if (!activeChunk) return [];
    const offsetInChunk = (page - 1) * PAGE_SIZE - currentChunkStart;
    return activeChunk.players.slice(offsetInChunk, offsetInChunk + PAGE_SIZE);
  }, [activeChunk, page, currentChunkStart]);

  const displayedPlayers = filteredPlayers ?? pagePlayers;

  const favoriteKeys = useMemo(() => {
    const set = new Set<string>();
    for (const f of favorites) {
      set.add(playerKey(f.name, f.tag));
    }
    return set;
  }, [favorites]);

  const quickSavedPlayers = useMemo(() => {
    const seen = new Set<string>();
    const out: SavedPlayerEntry[] = [];
    for (const item of [...favorites, ...history]) {
      const k = playerKey(item.name, item.tag);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(item);
      }
      if (out.length >= 5) break;
    }
    return out;
  }, [favorites, history]);

  const jumpToRank = useCallback(
    (rank: number) => {
      const clamped = Math.max(1, Math.min(totalPlayers, Math.floor(rank)));
      const targetPage = Math.floor((clamped - 1) / PAGE_SIZE) + 1;
      const targetChunk = chunkStartForPage(targetPage);
      setQueryInput("");
      setHighlightRank(clamped);
      setPage(targetPage);
      if (!chunks[targetChunk]) {
        void loadChunk(lbRegion, targetChunk);
      }
    },
    [totalPlayers, chunks, lbRegion, loadChunk],
  );

  const executeRankLookup = useCallback(
    async (riotId: string, regionOverride?: Region) => {
      const targetRegion = regionOverride ?? lbRegion;
      if (regionOverride && regionOverride !== lbRegion) {
        setLbRegion(regionOverride);
      }
      setLookupLoading(true);
      setLookupError(null);
      setLookupResult(null);

      try {
        const res = await lookupLeaderboardPlayer(targetRegion, riotId, apiKey);
        setLookupResult(res);
        if (res.foundOnLeaderboard && res.entry) {
          setHighlightRank(res.entry.rank);
        }
      } catch (err) {
        setLookupError(normalizeError(err));
      } finally {
        setLookupLoading(false);
      }
    },
    [lbRegion, apiKey],
  );

  const radiantThreshold = useMemo(() => {
    return metaSlice?.thresholds.find((t) => t.tierId === 27)?.rrThreshold ?? null;
  }, [metaSlice]);

  const top3Players = useMemo(() => {
    const firstChunk = chunks[0];
    if (!firstChunk) return [];
    return firstChunk.players.slice(0, 3);
  }, [chunks]);

  return (
    <div className="max-w-5xl mx-auto py-8 px-6 space-y-6 vt-animate-in">
      {/* Header + Region Selector */}
      <section className="vt-panel p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2.5">
              <Trophy className="w-4 h-4 text-[#ededed]" />
              <h1 className="text-lg font-semibold text-[#ededed] tracking-tight">
                リーダーボード
              </h1>
              <span className="font-num text-[11px] px-2 py-0.5 rounded-full border border-[rgba(255,255,255,0.09)] text-[#8f8f8f]">
                {lbRegion.toUpperCase()} · 上位 {totalPlayers.toLocaleString()} 名
              </span>
            </div>
            <p className="text-xs text-[#8f8f8f]">
              リージョン別の Radiant / Immortal ランキングと、Riot ID による順位検索
            </p>
          </div>

          <div className="flex items-center gap-3 self-start sm:self-auto">
            {metaSlice?.updatedAtIso && (
              <span className="text-[11px] text-[#5c5c5c] font-num">
                {formatUpdatedTime(metaSlice.updatedAtIso)}
              </span>
            )}
            <button
              type="button"
              disabled={isLoading}
              onClick={() =>
                void loadChunk(lbRegion, currentChunkStart, {
                  forceRefresh: true,
                  resetChunks: currentChunkStart === 0,
                })
              }
              className="h-8 px-3 rounded-[9px] bg-[#141414] hover:bg-[#1c1c1c] text-[#ededed] text-xs vt-hairline flex items-center gap-1.5 disabled:opacity-40 transition-colors cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? "animate-spin" : ""}`} />
              <span>更新</span>
            </button>
          </div>
        </div>

        {/* Region Tabs */}
        <div className="flex items-center gap-1.5 flex-wrap pt-1">
          {REGIONS.map((r) => {
            const active = lbRegion === r.id;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setLbRegion(r.id)}
                className={`h-8 px-3 rounded-[9px] text-xs transition-colors flex items-center gap-1.5 cursor-pointer border ${
                  active
                    ? "bg-[#ededed] text-[#0a0a0a] border-[#ededed] font-medium"
                    : "bg-[#111111] text-[#8f8f8f] border-[rgba(255,255,255,0.08)] hover:text-[#ededed] hover:border-white/20"
                }`}
              >
                <span className="font-num font-semibold">{r.code}</span>
                <span className={active ? "text-[#0a0a0a]/75" : "text-[#5c5c5c]"}>
                  {r.label}
                </span>
              </button>
            );
          })}
        </div>

        {/* Tier RR Cutoffs (Thresholds) */}
        {metaSlice && metaSlice.thresholds.length > 0 && (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 pt-1">
            {metaSlice.thresholds.map((th) => {
              const tierAsset = resolveTierAsset(assets, th.tierId);
              const tierLabel = tierAsset?.tierName || th.tierName;
              return (
                <button
                  key={th.tierId}
                  type="button"
                  onClick={() => jumpToRank(th.startIndex)}
                  title={`#${th.startIndex.toLocaleString()} 付近へ移動`}
                  className="group rounded-[10px] bg-[#111111] hover:bg-[#171717] vt-hairline p-3 flex items-center justify-between gap-3 text-left transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    {tierAsset?.smallIcon ? (
                      <img
                        src={tierAsset.smallIcon}
                        alt={tierLabel}
                        className="w-7 h-7 object-contain shrink-0"
                      />
                    ) : (
                      <div className="w-7 h-7 rounded-full bg-white/[0.06] shrink-0" />
                    )}
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-[#ededed] truncate">
                        {tierLabel}
                      </div>
                      <div className="font-num text-[10px] text-[#5c5c5c]">
                        #{th.startIndex.toLocaleString()}〜
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-num text-xs font-semibold text-[#ededed]">
                      {th.rrThreshold} RR
                    </div>
                    <div className="text-[10px] text-[#5c5c5c]">ボーダー</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* Player Rank Lookup & Filter Section */}
      <section className="vt-panel p-5 space-y-3.5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!trimmedQuery) return;
            if (hasHashTag) {
              void executeRankLookup(trimmedQuery);
            } else if (filteredPlayers && filteredPlayers.length === 1) {
              const only = filteredPlayers[0];
              if (!only.isAnonymized && only.tag) {
                void executeRankLookup(`${only.name}#${only.tag}`);
              }
            }
          }}
          className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5"
        >
          <div className="relative flex-1">
            <Search className="w-3.5 h-3.5 text-[#5c5c5c] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={queryInput}
              onChange={(e) => {
                setQueryInput(e.target.value);
                if (!e.target.value.trim()) {
                  setLookupError(null);
                }
              }}
              placeholder="自分の順位検索（例: Player#JP1）またはプレイヤー名で絞り込み…"
              className="w-full h-9 pl-9 pr-8 rounded-[10px] bg-[#111111] text-xs text-[#ededed] placeholder-[#5c5c5c] vt-hairline outline-none focus:border-white/25"
            />
            {queryInput && (
              <button
                type="button"
                onClick={() => {
                  setQueryInput("");
                  setLookupResult(null);
                  setLookupError(null);
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-[#5c5c5c] hover:text-[#ededed] cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          <button
            type="submit"
            disabled={!hasHashTag || lookupLoading}
            title="Riot ID（名前#タグ）で全15,000位から正確な順位を検索"
            className="h-9 px-4 rounded-[10px] bg-[#ededed] hover:bg-white text-[#0a0a0a] text-xs font-medium disabled:opacity-35 disabled:cursor-not-allowed transition-colors shrink-0 cursor-pointer"
          >
            {lookupLoading ? "検索中…" : "Riot ID で順位検索"}
          </button>
        </form>

        {/* Quick Saved Players Chips for 1-click self/friend rank check */}
        {quickSavedPlayers.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[11px] text-[#5c5c5c] mr-1">クイック順位確認:</span>
            {quickSavedPlayers.map((sp) => (
              <button
                key={`lb-quick-${sp.region}-${sp.name}-${sp.tag}`}
                type="button"
                onClick={() => {
                  const id = `${sp.name}#${sp.tag}`;
                  setQueryInput(id);
                  void executeRankLookup(id, sp.region);
                }}
                className="px-2.5 py-1 rounded-[8px] bg-[#111111] hover:bg-[#191919] vt-hairline text-[11px] text-[#8f8f8f] hover:text-[#ededed] transition-colors cursor-pointer"
              >
                <span className="text-[#ededed]">{sp.name}</span>
                <span className="font-num text-[#5c5c5c]">#{sp.tag}</span>
                <span className="font-num text-[10px] text-[#5c5c5c] ml-1.5 uppercase">
                  {sp.region}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Lookup Error */}
        {lookupError && (
          <ErrorBanner error={lookupError} onOpenSettings={onOpenSettings} />
        )}

        {/* Lookup Result Card */}
        {lookupResult && (
          <div className="rounded-[10px] bg-[#121212] border border-white/20 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            {lookupResult.foundOnLeaderboard && lookupResult.entry ? (
              <>
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="px-3 py-1.5 rounded-[9px] bg-[#ededed] text-[#0a0a0a] font-num text-sm font-bold shrink-0">
                    #{lookupResult.entry.rank.toLocaleString()}
                  </div>

                  {resolveTierAsset(assets, lookupResult.entry.tierId)?.smallIcon && (
                    <img
                      src={resolveTierAsset(assets, lookupResult.entry.tierId)!.smallIcon}
                      alt=""
                      className="w-8 h-8 object-contain shrink-0"
                    />
                  )}

                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#ededed] truncate">
                      {lookupResult.name}
                      <span className="font-num text-[#8f8f8f] font-normal">
                        #{lookupResult.tag}
                      </span>
                    </div>
                    <div className="font-num text-xs text-[#8f8f8f] flex items-center gap-2.5 flex-wrap mt-0.5">
                      <span className="text-[#ededed] font-medium">
                        {lookupResult.entry.rr.toLocaleString()} RR
                      </span>
                      <span>·</span>
                      <span>{lookupResult.entry.wins} 勝</span>
                      {lookupResult.entry.tierId < 27 &&
                        radiantThreshold !== null &&
                        radiantThreshold > lookupResult.entry.rr && (
                          <>
                            <span>·</span>
                            <span>
                              Radiant まであと{" "}
                              <strong className="text-[#ededed]">
                                {radiantThreshold - lookupResult.entry.rr} RR
                              </strong>
                            </span>
                          </>
                        )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => jumpToRank(lookupResult.entry!.rank)}
                    className="h-8 px-3 rounded-[8px] bg-white/[0.07] hover:bg-white/[0.12] text-xs text-[#ededed] transition-colors cursor-pointer"
                  >
                    周辺の順位を表示
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onSelectPlayer(
                        lookupResult.name,
                        lookupResult.tag,
                        lookupResult.region,
                      )
                    }
                    className="h-8 px-3 rounded-[8px] bg-[#ededed] hover:bg-white text-[#0a0a0a] text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <span>プロフィール</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-3 min-w-0">
                  {lookupResult.fallbackRank &&
                    resolveTierAsset(assets, lookupResult.fallbackRank.tierId)
                      ?.smallIcon && (
                      <img
                        src={
                          resolveTierAsset(assets, lookupResult.fallbackRank.tierId)!
                            .smallIcon
                        }
                        alt=""
                        className="w-8 h-8 object-contain shrink-0"
                      />
                    )}
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#ededed] truncate">
                      {lookupResult.name}
                      <span className="font-num text-[#8f8f8f] font-normal">
                        #{lookupResult.tag}
                      </span>
                    </div>
                    <div className="text-xs text-[#8f8f8f] mt-0.5">
                      現在ランク:{" "}
                      <span className="text-[#ededed] font-medium">
                        {lookupResult.fallbackRank?.tierName ?? "ランクなし"}
                      </span>{" "}
                      <span className="font-num">
                        ({lookupResult.fallbackRank?.rr ?? 0} RR)
                      </span>{" "}
                      — {lookupResult.region.toUpperCase()} リーダーボード圏外（上位{" "}
                      {totalPlayers.toLocaleString()} 位以内が対象）
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() =>
                    onSelectPlayer(
                      lookupResult.name,
                      lookupResult.tag,
                      lookupResult.region,
                    )
                  }
                  className="h-8 px-3.5 rounded-[8px] bg-[#ededed] hover:bg-white text-[#0a0a0a] text-xs font-medium flex items-center gap-1.5 shrink-0 cursor-pointer"
                >
                  <span>プロフィールを見る</span>
                  <ExternalLink className="w-3 h-3" />
                </button>
              </>
            )}
          </div>
        )}
      </section>

      {/* Error State */}
      {error && (
        <ErrorBanner
          error={error}
          onOpenSettings={onOpenSettings}
          onRetry={() => void loadChunk(lbRegion, currentChunkStart, { forceRefresh: true })}
        />
      )}

      {/* Top 3 Podium Cards (shown on Page 1 when not filtering) */}
      {!error && !isLoading && page === 1 && !filteredPlayers && top3Players.length === 3 && (
        <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {top3Players.map((p) => {
            const tierAsset = resolveTierAsset(assets, p.tierId);
            const canOpen = !p.isAnonymized && Boolean(p.tag);
            return (
              <div
                key={`podium-${p.rank}`}
                onClick={() => {
                  if (canOpen) onSelectPlayer(p.name, p.tag, lbRegion);
                }}
                className={`group relative overflow-hidden rounded-[12px] bg-[#0a0a0a]/90 vt-hairline p-5 transition-colors ${
                  canOpen ? "hover:border-white/25 cursor-pointer" : ""
                }`}
              >
                {p.cardWideUrl && (
                  <img
                    src={p.cardWideUrl}
                    alt=""
                    className="absolute inset-0 w-full h-full object-cover opacity-[0.16] group-hover:opacity-[0.24] transition-opacity pointer-events-none"
                    loading="lazy"
                  />
                )}
                <div className="absolute inset-0 bg-gradient-to-t from-[#0a0a0a] via-[#0a0a0a]/80 to-transparent pointer-events-none" />

                <div className="relative z-10 space-y-4">
                  <div className="flex items-center justify-between">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-[8px] font-num text-xs font-bold ${
                        p.rank === 1
                          ? "bg-[#ededed] text-[#0a0a0a]"
                          : "bg-white/[0.1] text-[#ededed] border border-white/15"
                      }`}
                    >
                      {p.rank === 1 && <Crown className="w-3.5 h-3.5" />}
                      #{p.rank}
                    </span>

                    {tierAsset?.smallIcon && (
                      <img
                        src={tierAsset.smallIcon}
                        alt={tierAsset.tierName}
                        className="w-7 h-7 object-contain"
                      />
                    )}
                  </div>

                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[#ededed] truncate flex items-center gap-1.5">
                      {p.isAnonymized && <EyeOff className="w-3.5 h-3.5 text-[#8f8f8f] shrink-0" />}
                      <span className="truncate">{p.name}</span>
                      {!p.isAnonymized && p.tag && (
                        <span className="font-num text-xs text-[#8f8f8f] font-normal shrink-0">
                          #{p.tag}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex items-baseline justify-between pt-1 vt-hairline-t">
                    <div className="font-num">
                      <span className="text-xl font-semibold text-[#ededed]">
                        {p.rr.toLocaleString()}
                      </span>
                      <span className="text-xs text-[#8f8f8f] ml-1">RR</span>
                    </div>
                    <div className="font-num text-xs text-[#8f8f8f]">
                      <span className="text-[#ededed] font-medium">{p.wins}</span> 勝
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* Main Leaderboard Table */}
      <section className="vt-panel overflow-hidden">
        {/* Table Top Controls: Page Range & Rank Jump */}
        <div className="px-5 py-3.5 vt-hairline-b flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="text-xs text-[#8f8f8f] font-num">
            {filteredPlayers ? (
              <span>
                絞り込み結果: <strong className="text-[#ededed]">{filteredPlayers.length}</strong> 件
                （読込済み {allLoadedPlayers.length.toLocaleString()} 名中）
              </span>
            ) : (
              <span>
                表示順位:{" "}
                <strong className="text-[#ededed]">
                  #{((page - 1) * PAGE_SIZE + 1).toLocaleString()} – #
                  {Math.min(totalPlayers, page * PAGE_SIZE).toLocaleString()}
                </strong>{" "}
                / 全 {totalPlayers.toLocaleString()} 名
              </span>
            )}
          </div>

          {/* Direct Rank Jump + Pagination */}
          <div className="flex items-center gap-2 flex-wrap">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const n = Number(rankJumpInput.replace(/[^0-9]/g, ""));
                if (Number.isFinite(n) && n >= 1) {
                  jumpToRank(n);
                  setRankJumpInput("");
                }
              }}
              className="flex items-center gap-1"
            >
              <div className="relative">
                <Hash className="w-3 h-3 text-[#5c5c5c] absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={rankJumpInput}
                  onChange={(e) => setRankJumpInput(e.target.value)}
                  placeholder="順位移動"
                  className="w-24 h-7 pl-6 pr-2 rounded-[7px] bg-[#111111] text-[11px] font-num text-[#ededed] placeholder-[#5c5c5c] vt-hairline outline-none"
                />
              </div>
            </form>

            {!filteredPlayers && (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={page <= 1 || isLoading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="h-7 w-7 rounded-[7px] bg-[#111111] hover:bg-[#191919] text-[#ededed] vt-hairline flex items-center justify-center disabled:opacity-35 cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="px-2.5 font-num text-xs text-[#8f8f8f]">
                  <span className="text-[#ededed]">{page}</span> / {totalPages}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages || isLoading}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="h-7 w-7 rounded-[7px] bg-[#111111] hover:bg-[#191919] text-[#ededed] vt-hairline flex items-center justify-center disabled:opacity-35 cursor-pointer"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Rows */}
        {isLoading && displayedPlayers.length === 0 ? (
          <div className="divide-y divide-[rgba(255,255,255,0.06)]">
            {Array.from({ length: 12 }).map((_, idx) => (
              <div key={idx} className="px-5 py-3.5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="w-10 h-4 rounded bg-white/[0.06] animate-pulse" />
                  <div className="w-8 h-8 rounded-[8px] bg-white/[0.06] animate-pulse" />
                  <div className="w-40 h-4 rounded bg-white/[0.06] animate-pulse" />
                </div>
                <div className="w-24 h-4 rounded bg-white/[0.06] animate-pulse" />
              </div>
            ))}
          </div>
        ) : displayedPlayers.length === 0 ? (
          <div className="py-14 px-6 text-center space-y-2">
            <p className="text-sm text-[#ededed]">該当するプレイヤーが見つかりません</p>
            {trimmedQuery && !hasHashTag && (
              <p className="text-xs text-[#8f8f8f]">
                上位1,000位以降を検索する場合は「名前#タグ」形式で入力して「Riot ID で順位検索」を押してください
              </p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="text-[11px] text-[#5c5c5c] vt-hairline-b bg-[#080808]">
                  <th className="py-2.5 pl-5 pr-3 font-medium w-20">順位</th>
                  <th className="py-2.5 px-3 font-medium">プレイヤー</th>
                  <th className="py-2.5 px-3 font-medium w-40">ランクティア</th>
                  <th className="py-2.5 px-3 font-medium text-right w-28">レーティング</th>
                  <th className="py-2.5 pl-3 pr-5 font-medium text-right w-28">勝利数</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[rgba(255,255,255,0.06)] text-xs">
                {displayedPlayers.map((p) => {
                  const tierAsset = resolveTierAsset(assets, p.tierId);
                  const tierLabel =
                    tierAsset?.tierName ||
                    (p.tierId === 27
                      ? "Radiant"
                      : p.tierId === 26
                        ? "Immortal 3"
                        : p.tierId === 25
                          ? "Immortal 2"
                          : "Immortal 1");
                  const canOpen = !p.isAnonymized && Boolean(p.tag);
                  const isFav =
                    canOpen && favoriteKeys.has(playerKey(p.name, p.tag));
                  const isHighlighted = highlightRank === p.rank;

                  return (
                    <tr
                      key={`${p.rank}-${p.puuid ?? p.name}`}
                      onClick={() => {
                        if (canOpen) onSelectPlayer(p.name, p.tag, lbRegion);
                      }}
                      className={`transition-colors ${
                        isHighlighted
                          ? "bg-white/[0.11]"
                          : canOpen
                            ? "hover:bg-white/[0.04] cursor-pointer"
                            : "opacity-75"
                      }`}
                    >
                      {/* Rank */}
                      <td className="py-2.5 pl-5 pr-3 font-num whitespace-nowrap">
                        <span
                          className={`inline-flex items-center justify-center min-w-[36px] px-2 py-0.5 rounded-[6px] text-xs ${
                            p.rank === 1
                              ? "bg-[#ededed] text-[#0a0a0a] font-bold"
                              : p.rank <= 3
                                ? "bg-white/[0.1] text-[#ededed] font-semibold"
                                : "text-[#8f8f8f]"
                          }`}
                        >
                          #{p.rank}
                        </span>
                      </td>

                      {/* Player Card + Riot ID */}
                      <td className="py-2.5 px-3 min-w-[200px]">
                        <div className="flex items-center gap-3 min-w-0">
                          {p.cardSmallUrl ? (
                            <img
                              src={p.cardSmallUrl}
                              alt=""
                              className="w-7 h-7 rounded-[6px] object-cover border border-white/[0.08] shrink-0"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-7 h-7 rounded-[6px] bg-white/[0.04] border border-white/[0.08] flex items-center justify-center shrink-0">
                              <EyeOff className="w-3.5 h-3.5 text-[#5c5c5c]" />
                            </div>
                          )}

                          <div className="min-w-0 flex items-center gap-1.5">
                            <span
                              className={`truncate ${
                                p.isAnonymized
                                  ? "text-[#8f8f8f] italic"
                                  : "text-[#ededed] font-medium"
                              }`}
                            >
                              {p.name}
                            </span>
                            {!p.isAnonymized && p.tag && (
                              <span className="font-num text-[#5c5c5c] shrink-0">
                                #{p.tag}
                              </span>
                            )}
                            {isFav && (
                              <Pin className="w-3 h-3 text-[#ededed] shrink-0 ml-1" />
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Tier */}
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          {tierAsset?.smallIcon && (
                            <img
                              src={tierAsset.smallIcon}
                              alt={tierLabel}
                              className="w-5 h-5 object-contain shrink-0"
                              loading="lazy"
                            />
                          )}
                          <span className="text-[#8f8f8f]">{tierLabel}</span>
                        </div>
                      </td>

                      {/* RR */}
                      <td className="py-2.5 px-3 text-right font-num whitespace-nowrap">
                        <span className="text-[#ededed] font-semibold">
                          {p.rr.toLocaleString()}
                        </span>
                        <span className="text-[11px] text-[#5c5c5c] ml-1">RR</span>
                      </td>

                      {/* Wins */}
                      <td className="py-2.5 pl-3 pr-5 text-right font-num whitespace-nowrap text-[#8f8f8f]">
                        <span className="text-[#ededed]">{p.wins}</span> 勝
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Bottom Pagination Footer */}
        {!filteredPlayers && totalPages > 1 && (
          <div className="px-5 py-3.5 vt-hairline-t flex items-center justify-between gap-4 bg-[#080808]">
            <button
              type="button"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="h-8 px-3 rounded-[8px] bg-[#121212] hover:bg-[#1b1b1b] text-xs text-[#ededed] vt-hairline disabled:opacity-35 flex items-center gap-1 cursor-pointer"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>前の100名</span>
            </button>

            <div className="flex items-center gap-1 font-num text-xs">
              {buildPageButtons(page, totalPages).map((pNum, i) =>
                pNum === -1 ? (
                  <span key={`dots-${i}`} className="px-1.5 text-[#5c5c5c]">
                    …
                  </span>
                ) : (
                  <button
                    key={pNum}
                    type="button"
                    onClick={() => setPage(pNum)}
                    className={`min-w-[30px] h-7 px-2 rounded-[7px] transition-colors cursor-pointer ${
                      page === pNum
                        ? "bg-[#ededed] text-[#0a0a0a] font-semibold"
                        : "text-[#8f8f8f] hover:bg-white/[0.06] hover:text-[#ededed]"
                    }`}
                  >
                    {pNum}
                  </button>
                ),
              )}
            </div>

            <button
              type="button"
              disabled={page >= totalPages || isLoading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              className="h-8 px-3 rounded-[8px] bg-[#121212] hover:bg-[#1b1b1b] text-xs text-[#ededed] vt-hairline disabled:opacity-35 flex items-center gap-1 cursor-pointer"
            >
              <span>次の100名</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function buildPageButtons(current: number, total: number): number[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  const sorted = Array.from(pages)
    .filter((p) => p >= 1 && p <= total)
    .sort((a, b) => a - b);
  const out: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) {
      out.push(-1);
    }
    out.push(sorted[i]);
  }
  return out;
}

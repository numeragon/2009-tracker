import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, ScanEye } from "lucide-react";
import type {
  LiveMatchPlayerRaw,
  LiveMatchResponse,
  LivePlayerRankInfo,
  MatchLoadoutsResponse,
  Region,
  StoreCatalog,
  ValorantAssetsCatalog,
} from "../types/valorant";
import {
  fetchLiveMatchFromClient,
  fetchMatchLoadouts,
  fetchPregamePicks,
  fetchPlayerRankByPuuid,
  formatLiveModeLabel,
  normalizeRegion,
} from "../lib/liveMatchApi";
import { loadSettingsSync } from "../lib/storage";
import {
  buildPlayerCardUrls,
  loadValorantAssets,
  resolveAgentAsset,
  resolveMapAsset,
  resolveTierAsset,
} from "../lib/valorantAssets";
import { loadStoreCatalog, resolveStoreSkin } from "../lib/storeCatalog";
import { replayGetState } from "../lib/replayApi";

const EMPTY_ASSETS: ValorantAssetsCatalog = {
  agentsById: {},
  agentsByKey: {},
  mapsById: {},
  mapsByKey: {},
  tiersById: {},
  weaponsById: {},
};

const CATEGORY_ORDER = [
  "Sidearm",
  "SMG",
  "Shotgun",
  "Melee",
  "Rifle",
  "Sniper",
  "Heavy",
];

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Browser preview used when the overlay is opened in Vite without Tauri. */
const DEV_MOCK: LiveMatchResponse | null = import.meta.env.DEV
  ? {
      status: "PREGAME",
      message: null,
      matchId: "overlay-demo",
      mapUrl: null,
      modeId: null,
      queueId: "competitive",
      serverPod: "AP-SGP-1",
      detectedRegion: "ap",
      detectedShard: "ap",
      selfPuuid: "self",
      allySide: null,
      players: [
        ["self", "自分", "JP1", true, true, "own"],
        ["a2", "AllyTwo", "JP2", true, false, "own"],
        ["a3", "AllyThree", "JP3", true, false, "own"],
        ["a4", "SoloAlly", "JP4", true, false, null],
        ["a5", "SoloAlly2", "JP5", true, false, null],
        ["e1", "EnemyOne", "NA1", false, false, "h:e1"],
        ["e2", "EnemyTwo", "NA2", false, false, "h:e1"],
        ["e3", "EnemyThree", "NA3", false, false, "h:e1"],
        ["e4", "EnemyFour", "NA4", false, false, "h:e4"],
        ["e5", "EnemyFive", "NA5", false, false, "h:e4"],
      ].map(([puuid, gameName, tagLine, isAlly, isSelf, partyId]) => ({
        puuid: puuid as string,
        gameName: gameName as string,
        tagLine: tagLine as string,
        teamId: isAlly ? "Blue" : "Red",
        isAlly: isAlly as boolean,
        isSelf: isSelf as boolean,
        agentId: "",
        selectionState: "locked",
        accountLevel: 120,
        hideAccountLevel: false,
        isIncognito: false,
        cardId: "",
        pregameTier: 16,
        partyReady: null,
        isPartyOwner: null,
        partyId: (partyId as string | null) ?? null,
        partySize: partyId ? (partyId === "own" ? 3 : 2) : 1,
        partyInferred: typeof partyId === "string" && partyId.startsWith("h:"),
        isPartyMember: partyId === "own",
      })),
    }
  : null;

function OverlayImage({
  primary,
  fallback,
  className,
}: {
  primary?: string;
  fallback?: string;
  className?: string;
}) {
  const [src, setSrc] = useState(primary ?? "");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setSrc(primary ?? "");
    setFailed(false);
  }, [primary]);

  if (failed || !src) {
    return <span className="text-[8px] text-[#3a3a3a]">—</span>;
  }

  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      className={className}
      onError={() => {
        if (fallback && fallback !== src) {
          setSrc(fallback);
        } else {
          setFailed(true);
        }
      }}
    />
  );
}

interface PartyLabel {
  label: string;
  inferred: boolean;
  isOwn: boolean;
}

function partyLabels(players: LiveMatchPlayerRaw[]): Map<string, PartyLabel> {
  const groups = new Map<
    string,
    { count: number; inferred: boolean; isOwn: boolean }
  >();
  for (const player of players) {
    if (!player.partyId) continue;
    const group = groups.get(player.partyId) ?? {
      count: 0,
      inferred: false,
      isOwn: false,
    };
    group.count += 1;
    group.inferred = group.inferred || Boolean(player.partyInferred);
    group.isOwn = group.isOwn || Boolean(player.isSelf);
    groups.set(player.partyId, group);
  }
  const ordered = [...groups.entries()]
    .filter(([, group]) => group.count > 1)
    .sort((a, b) => Number(b[1].isOwn) - Number(a[1].isOwn));
  const labels = new Map<string, PartyLabel>();
  ordered.forEach(([id, group], index) => {
    labels.set(id, {
      label: `P${index + 1}`,
      inferred: group.inferred,
      isOwn: group.isOwn,
    });
  });
  return labels;
}

export function OverlayView() {
  const settings = useMemo(() => loadSettingsSync(), []);
  const [region, setRegion] = useState<Region>(settings.defaultRegion);
  const [live, setLive] = useState<LiveMatchResponse | null>(null);
  const [picks, setPicks] = useState<
    Record<string, { agentId: string; selectionState: string }>
  >({});
  const [ranks, setRanks] = useState<
    Record<string, LivePlayerRankInfo | undefined>
  >({});
  const [assets, setAssets] = useState<ValorantAssetsCatalog>(EMPTY_ASSETS);
  const [catalog, setCatalog] = useState<StoreCatalog | null>(null);
  const [loadouts, setLoadouts] = useState<MatchLoadoutsResponse | null>(null);
  const [hotkeyLabel, setHotkeyLabel] = useState("F8");
  const [hovered, setHovered] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const ranksRef = useRef<Record<string, LivePlayerRankInfo | undefined>>({});
  const assetsRef = useRef<ValorantAssetsCatalog>(EMPTY_ASSETS);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadValorantAssets().then((loaded) => {
      if (cancelled) return;
      assetsRef.current = loaded;
      setAssets(loaded);
    });
    void loadStoreCatalog().then((loaded) => {
      if (!cancelled) setCatalog(loaded);
    });
    if (isTauriRuntime()) {
      void replayGetState()
        .then((state) => {
          if (!cancelled) setHotkeyLabel(state.hotkeyLabels.overlayToggle);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, []);

  // Live match / agent-select data.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      let data: LiveMatchResponse;
      if (isTauriRuntime()) {
        try {
          data = await fetchLiveMatchFromClient(
            region,
            settings.apiKey || undefined,
          );
        } catch {
          return;
        }
      } else {
        if (!DEV_MOCK) return;
        data = DEV_MOCK;
      }
      if (cancelled) return;
      setLive(data);

      const detected = normalizeRegion(data.detectedRegion, region);
      if (detected !== region) setRegion(detected);

      const missing = data.players.filter(
        (player) => !ranksRef.current[player.puuid.toLowerCase()],
      );
      if (missing.length > 0 && isTauriRuntime()) {
        const loaded = await Promise.all(
          missing.map(async (player) => {
            const rank = await fetchPlayerRankByPuuid(player.puuid, detected);
            return [player.puuid.toLowerCase(), rank] as const;
          }),
        );
        if (cancelled) return;
        const next = { ...ranksRef.current };
        for (const [key, rank] of loaded) {
          if (rank) next[key] = rank;
        }
        ranksRef.current = next;
        setRanks(next);
      }
    };
    void tick();
    const timer = window.setInterval(tick, 3500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [region, settings.apiKey]);

  // Agent picks change quickly during agent select.
  useEffect(() => {
    if (live?.status !== "PREGAME" || !isTauriRuntime()) return;
    let cancelled = false;
    const tick = async () => {
      const result = await fetchPregamePicks(region);
      if (cancelled || !result.ok) return;
      const next: Record<string, { agentId: string; selectionState: string }> =
        {};
      for (const pick of result.picks) {
        next[pick.puuid.toLowerCase()] = {
          agentId: pick.agentId,
          selectionState: pick.selectionState,
        };
      }
      setPicks(next);
    };
    void tick();
    const timer = window.setInterval(tick, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [live?.status, region]);

  // Fetch every player's locker once the match id is known.
  useEffect(() => {
    const phase =
      live?.status === "PREGAME"
        ? "PREGAME"
        : live?.status === "IN_GAME"
          ? "IN_GAME"
          : null;
    if (!live?.matchId || !phase) {
      setLoadouts(null);
      return;
    }
    if (!isTauriRuntime()) {
      if (!DEV_MOCK) return;
      const weapons = Object.values(assetsRef.current.weaponsById).map(
        (weapon) => ({ weaponId: weapon.uuid, items: [] }),
      );
      setLoadouts({
        ok: true,
        message: null,
        players: DEV_MOCK.players.map((player) => ({
          puuid: player.puuid.toLowerCase(),
          weapons,
        })),
      });
      return;
    }
    let cancelled = false;
    void fetchMatchLoadouts(live.matchId, phase, region).then((result) => {
      if (!cancelled && result.ok) setLoadouts(result);
    });
    return () => {
      cancelled = true;
    };
  }, [live?.matchId, live?.status, region, assets]);

  // The overlay window is click-through, so hover is resolved from the global
  // cursor position instead of mouse events.
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const position = await invoke<{ x: number; y: number } | null>(
          "overlay_cursor",
        );
        if (cancelled) return;
        if (!position) {
          setHovered(null);
          return;
        }
        const element = document.elementFromPoint(position.x, position.y);
        if (element?.closest("[data-overlay-inventory]")) return;
        const row = element?.closest<HTMLElement>("[data-overlay-player]");
        setHovered(row?.dataset.overlayPlayer ?? null);
      } catch {
        // Ignore transient IPC errors.
      }
    };
    const timer = window.setInterval(tick, 90);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const players = useMemo(() => {
    const list = live?.players ?? [];
    return list.map((player) => {
      const pick = picks[player.puuid.toLowerCase()];
      if (!pick) return player;
      return {
        ...player,
        agentId: pick.agentId || player.agentId,
        selectionState: pick.selectionState || player.selectionState,
      };
    });
  }, [live?.players, picks]);

  const allies = players.filter((player) => player.isAlly);
  const enemies = players.filter((player) => !player.isAlly);
  const allyLabels = partyLabels(allies);
  const enemyLabels = partyLabels(enemies);

  const hoveredPlayer = hovered
    ? (players.find((player) => player.puuid === hovered) ?? null)
    : null;
  const canShowLoadout =
    Boolean(live?.matchId) &&
    (live?.status === "PREGAME" || live?.status === "IN_GAME");

  const phaseLabel =
    live?.status === "PREGAME"
      ? "AGENT SELECT"
      : live?.status === "IN_GAME"
        ? "IN MATCH"
        : "STANDBY";
  const mapAsset = live?.mapUrl
    ? resolveMapAsset(assets, null, live.mapUrl)
    : undefined;
  const mapLabel = mapAsset?.displayName || "マップ未確定";
  const modeLabel = formatLiveModeLabel(live?.modeId, live?.queueId);

  const hoveredRank = hoveredPlayer
    ? ranks[hoveredPlayer.puuid.toLowerCase()]
    : undefined;
  const hoveredTier = hoveredPlayer
    ? resolveTierAsset(
        assets,
        hoveredRank?.tierId ?? hoveredPlayer.pregameTier ?? 0,
      )
    : undefined;
  const hoveredLoadout = hoveredPlayer
    ? (loadouts?.players.find(
        (player) => player.puuid === hoveredPlayer.puuid.toLowerCase(),
      ) ?? null)
    : null;

  const weaponEntries = (hoveredLoadout?.weapons ?? [])
    .map((weaponEntry) => {
      const weapon = assets.weaponsById[weaponEntry.weaponId.toLowerCase()];
      const skin = catalog
        ? weaponEntry.items
            .map(
              (item) =>
                resolveStoreSkin(catalog, item.id) ??
                resolveStoreSkin(catalog, item.typeId),
            )
            .find(Boolean)
        : undefined;
      const category = weapon?.category?.split("::").pop() ?? "";
      return { weaponEntry, weapon, skin, category };
    })
    .sort((a, b) => {
      const categoryDiff =
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
      return categoryDiff !== 0
        ? categoryDiff
        : (a.weapon?.cost ?? 0) - (b.weapon?.cost ?? 0);
    });

  return (
    <div className="h-screen w-screen bg-[#060606] p-2">
      <div
        className="flex h-full w-full flex-col overflow-hidden rounded-[14px] border border-[rgba(255,255,255,0.12)] text-[#ededed]"
        style={{ backgroundColor: "rgba(6, 6, 6, 0.96)" }}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-4 py-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#ededed] opacity-40" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#ededed]" />
            </span>
            <span className="text-[11px] font-medium tracking-[0.2em] text-[#ededed]">
              {phaseLabel}
            </span>
            <span className="truncate text-[10px] text-[#8f8f8f]">
              {mapLabel} · {modeLabel}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-[9px] text-[#5c5c5c]">
            <span className="font-num">{hotkeyLabel}</span>
            <span>で表示 / 非表示</span>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 gap-3 p-3">
          {players.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[#5c5c5c]">
              <Loader2 className="h-5 w-5 animate-spin" />
              <p className="text-[11px]">
                {live ? "試合データを待っています…" : "接続中…"}
              </p>
            </div>
          ) : (
            <>
          <TeamColumn
            title="味方チーム"
            players={allies}
            labels={allyLabels}
            ranks={ranks}
            assets={assets}
            hovered={hovered}
            onHover={setHovered}
          />
          <TeamColumn
            title="相手チーム"
            players={enemies}
            labels={enemyLabels}
            ranks={ranks}
            assets={assets}
            hovered={hovered}
            onHover={setHovered}
          />

          <aside
            data-overlay-inventory
            className="flex w-[390px] shrink-0 flex-col overflow-hidden rounded-[10px] border border-[rgba(255,255,255,0.08)] bg-white/[0.02]"
          >
            {hoveredPlayer ? (
              <>
                <div className="relative shrink-0 border-b border-[rgba(255,255,255,0.08)] px-3 py-2">
                  <p className="text-[8px] uppercase tracking-[0.24em] text-[#5c5c5c]">
                    Player Inventory
                  </p>
                  <div className="mt-0.5 flex items-center justify-between gap-2">
                    <p className="min-w-0 truncate text-[12px] font-medium text-[#ededed]">
                      {hoveredPlayer.gameName || "Player"}
                      {hoveredPlayer.tagLine && (
                        <span className="ml-0.5 font-num text-[10px] font-normal text-[#8f8f8f]">
                          #{hoveredPlayer.tagLine}
                        </span>
                      )}
                    </p>
                    <div className="flex shrink-0 items-center gap-1">
                      {hoveredTier?.smallIcon && (
                        <img
                          src={hoveredTier.smallIcon}
                          alt=""
                          className="h-3.5 w-3.5 object-contain"
                        />
                      )}
                      <span className="text-[9px] text-[#8f8f8f]">
                        {hoveredTier?.tierName || "Unranked"}
                      </span>
                    </div>
                  </div>
                  <p className="mt-0.5 font-num text-[9px] text-[#5c5c5c]">
                    Lv. {hoveredPlayer.accountLevel}
                    {hoveredRank?.kd !== null && hoveredRank?.kd !== undefined
                      ? ` · K/D ${hoveredRank.kd.toFixed(2)}`
                      : ""}
                    {hoveredRank?.seasonWinRate !== null &&
                    hoveredRank?.seasonWinRate !== undefined
                      ? ` · 勝率 ${hoveredRank.seasonWinRate.toFixed(1)}%`
                      : ""}
                  </p>
                </div>

                <div className="min-h-0 flex-1 overflow-hidden p-2">
                  {!loadouts && canShowLoadout ? (
                    <div className="flex h-full items-center justify-center gap-2 text-[10px] text-[#8f8f8f]">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      インベントリを読み込み中…
                    </div>
                  ) : !canShowLoadout ? (
                    <p className="p-2 text-[10px] leading-relaxed text-[#8f8f8f]">
                      インベントリは試合中（エージェント選択・試合内）に表示できます。
                    </p>
                  ) : weaponEntries.length === 0 ? (
                    <p className="p-2 text-[10px] text-[#8f8f8f]">
                      装備情報が見つかりませんでした。
                    </p>
                  ) : (
                    <div className="grid grid-cols-3 gap-1">
                      {weaponEntries.map(({ weaponEntry, weapon, skin }) => {
                        const isStandard =
                          !skin ||
                          /スタンダード|standard|default/i.test(skin.name);
                        const icon = isStandard
                          ? (weapon?.displayIcon ?? "")
                          : (skin?.icon || weapon?.displayIcon || "");
                        return (
                          <div
                            key={weaponEntry.weaponId}
                            className="flex items-center gap-1.5 rounded-[4px] border border-[rgba(255,255,255,0.07)] bg-black/30 px-1.5 py-1"
                          >
                            <div className="flex h-5 w-9 shrink-0 items-center justify-center">
                              <OverlayImage
                                primary={icon}
                                fallback={weapon?.displayIcon}
                                className="max-h-5 max-w-9 object-contain"
                              />
                            </div>
                            <div className="min-w-0">
                              <p
                                className="truncate text-[9px] text-[#ededed]"
                                title={weapon?.displayName}
                              >
                                {weapon?.displayName || "武器"}
                              </p>
                              <p
                                className="truncate text-[8px] text-[#5c5c5c]"
                                title={skin?.name}
                              >
                                {skin?.name || "デフォルト"}
                              </p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-[#5c5c5c]">
                <ScanEye className="h-5 w-5" />
                <p className="text-[10px] leading-relaxed">
                  プレイヤーにカーソルを合わせると
                  <br />
                  インベントリを表示します
                </p>
              </div>
            )}
          </aside>
            </>
          )}
        </div>

        <footer className="flex shrink-0 items-center justify-between border-t border-[rgba(255,255,255,0.06)] px-4 py-1 text-[8px] text-[#3a3a3a]">
          <span>#2009 tracker overlay</span>
          <span className="font-num">
            {new Date(now).toLocaleTimeString("ja-JP", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </footer>
      </div>
    </div>
  );
}

function TeamColumn({
  title,
  players,
  labels,
  ranks,
  assets,
  hovered,
  onHover,
}: {
  title: string;
  players: LiveMatchPlayerRaw[];
  labels: Map<string, PartyLabel>;
  ranks: Record<string, LivePlayerRankInfo | undefined>;
  assets: ValorantAssetsCatalog;
  hovered: string | null;
  onHover: (puuid: string | null) => void;
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[10px] border border-[rgba(255,255,255,0.08)] bg-white/[0.02]">
      <div className="flex shrink-0 items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-2.5 py-1.5">
        <span className="text-[9px] uppercase tracking-[0.18em] text-[#8f8f8f]">
          {title}
        </span>
        <span className="font-num text-[9px] text-[#5c5c5c]">
          {players.length}
        </span>
      </div>
      <div
        className="flex min-h-0 flex-1 flex-col gap-0.5 p-1.5"
        onMouseLeave={() => onHover(null)}
      >
        {players.map((player) => (
          <PlayerRow
            key={player.puuid}
            player={player}
            label={player.partyId ? labels.get(player.partyId) : undefined}
            rank={ranks[player.puuid.toLowerCase()]}
            assets={assets}
            hovered={hovered === player.puuid}
            onHover={onHover}
          />
        ))}
      </div>
    </div>
  );
}

function PlayerRow({
  player,
  label,
  rank,
  assets,
  hovered,
  onHover,
}: {
  player: LiveMatchPlayerRaw;
  label?: PartyLabel;
  rank?: LivePlayerRankInfo;
  assets: ValorantAssetsCatalog;
  hovered: boolean;
  onHover: (puuid: string | null) => void;
}) {
  const agent = player.agentId
    ? resolveAgentAsset(assets, player.agentId, null)
    : undefined;
  const tierId = rank?.tierId ?? player.pregameTier ?? 0;
  const tier = resolveTierAsset(assets, tierId);
  const card = buildPlayerCardUrls(player.cardId || undefined);
  const name = player.gameName || "Player";

  return (
    <div
      data-overlay-player={player.puuid}
      onMouseEnter={() => onHover(player.puuid)}
      className={`flex items-center gap-2 rounded-[6px] px-2 py-1 transition-colors duration-100 ${
        hovered ? "bg-white/[0.09]" : player.isSelf ? "bg-white/[0.04]" : ""
      }`}
    >
      <div className="relative h-7 w-7 shrink-0 overflow-hidden rounded-[5px] border border-[rgba(255,255,255,0.1)] bg-black">
        {agent?.displayIcon ? (
          <img
            src={agent.displayIcon}
            alt=""
            className={`h-full w-full object-cover ${
              player.selectionState && player.selectionState !== "locked"
                ? "opacity-60"
                : ""
            }`}
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-[9px] text-[#5c5c5c]">
            ?
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="truncate text-[11px] text-[#ededed]">{name}</span>
          {player.isSelf && (
            <span className="shrink-0 rounded border border-white/25 px-1 text-[8px] text-[#ededed]">
              YOU
            </span>
          )}
          {label && (
            <span
              className={`shrink-0 rounded border px-1 text-[8px] ${
                label.isOwn
                  ? "border-white/30 text-[#ededed]"
                  : label.inferred
                    ? "border-dashed border-[rgba(255,255,255,0.22)] text-[#8f8f8f]"
                    : "border-[rgba(255,255,255,0.16)] text-[#8f8f8f]"
              }`}
              title={
                label.inferred
                  ? "同じパーティ（過去の試合から推定）"
                  : "同じパーティ"
              }
            >
              {label.label}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-[9px] text-[#5c5c5c]">
          <span className="truncate">
            {agent?.displayName ||
              (player.selectionState === "locked"
                ? "エージェント"
                : "未選択")}
          </span>
          <span>·</span>
          <span className="whitespace-nowrap font-num">
            {player.hideAccountLevel && !player.isSelf
              ? "Lv. —"
              : `Lv. ${player.accountLevel}`}
          </span>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1" title={tier?.tierName || "Unranked"}>
        {tier?.smallIcon ? (
          <img
            src={tier.smallIcon}
            alt=""
            className="h-4 w-4 object-contain"
          />
        ) : card.small ? (
          <img
            src={card.small}
            alt=""
            className="h-4 w-4 rounded object-cover opacity-60"
          />
        ) : null}
      </div>
    </div>
  );
}

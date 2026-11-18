import { ChevronRight } from "lucide-react";
import type {
  MatchModeFilter,
  MatchSummaryItem,
  ValorantAssetsCatalog,
} from "../types/valorant";
import type { ApiClientError } from "../lib/errors";
import { resolveAgentAsset, resolveMapAsset } from "../lib/valorantAssets";
import { ErrorBanner } from "./ErrorBanner";
import { MatchListSkeleton } from "./Skeletons";

const MODE_FILTERS: Array<{ value: MatchModeFilter; label: string }> = [
  { value: "all", label: "すべて" },
  { value: "competitive", label: "コンペティティブ" },
  { value: "unrated", label: "アンレート" },
  { value: "swiftplay", label: "スイフトプレイ" },
];

function formatMatchDate(iso: string, ts: number): string {
  const time = ts > 0 ? ts : Date.parse(iso);
  if (!Number.isFinite(time) || time <= 0) return "—";
  const d = new Date(time);
  const yyyy = d.getFullYear();
  const nowYear = new Date().getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return yyyy !== nowYear ? `${yyyy}/${mm}/${dd} ${hh}:${min}` : `${mm}/${dd} ${hh}:${min}`;
}

interface MatchHistoryTabProps {
  matches: MatchSummaryItem[];
  modeFilter: MatchModeFilter;
  onChangeModeFilter: (mode: MatchModeFilter) => void;
  isLoading: boolean;
  error: ApiClientError | null;
  onRetry: () => void;
  onOpenSettings?: () => void;
  onSelectMatch: (match: MatchSummaryItem) => void;
  assets: ValorantAssetsCatalog;
}

export function MatchHistoryTab({
  matches,
  modeFilter,
  onChangeModeFilter,
  isLoading,
  error,
  onRetry,
  onOpenSettings,
  onSelectMatch,
  assets,
}: MatchHistoryTabProps) {
  return (
    <div className="space-y-5 vt-animate-in">
      {/* Mode Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex items-center p-1 rounded-[12px] bg-[#0a0a0a] border border-[rgba(255,255,255,0.09)]">
          {MODE_FILTERS.map((f) => {
            const active = modeFilter === f.value;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => onChangeModeFilter(f.value)}
                className={`px-3.5 py-1.5 text-xs rounded-[9px] transition-colors duration-150 cursor-pointer ${
                  active
                    ? "bg-white/[0.09] text-[#ededed] font-medium"
                    : "text-[#8f8f8f] hover:text-[#ededed]"
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>

        <div className="font-num text-xs text-[#5c5c5c]">
          直近 {matches.length} 試合を表示
        </div>
      </div>

      {error && <ErrorBanner error={error} onRetry={onRetry} onOpenSettings={onOpenSettings} />}

      {isLoading ? (
        <MatchListSkeleton />
      ) : matches.length === 0 ? (
        <div className="vt-panel p-10 text-center text-sm text-[#8f8f8f]">
          該当するモードの試合履歴が見つかりませんでした。
        </div>
      ) : (
        <div className="vt-panel divide-y divide-[rgba(255,255,255,0.09)] overflow-hidden">
          {matches.map((m) => {
            const agent = resolveAgentAsset(assets, m.agentId, m.agentName);
            const map = resolveMapAsset(assets, m.mapId, m.mapName);
            const agentLabel = agent?.displayName || m.agentName;
            const mapLabel = map?.displayName || m.mapName;
            const kd = m.deaths > 0 ? (m.kills / m.deaths).toFixed(2) : m.kills.toFixed(2);

            const isWin = m.result === "win";
            const isLoss = m.result === "loss";

            return (
              <button
                key={m.matchId}
                type="button"
                onClick={() => onSelectMatch(m)}
                className="w-full text-left px-5 py-4 flex items-center justify-between gap-4 hover:bg-white/[0.025] transition-colors duration-150 cursor-pointer group"
              >
                {/* Left: Result + Agent Icon + Map & Mode */}
                <div className="flex items-center gap-4 min-w-0">
                  <div
                    className={`w-1 h-10 rounded-full shrink-0 ${
                      isWin
                        ? "bg-[var(--semantic-win)]"
                        : isLoss
                          ? "bg-[var(--semantic-loss)]"
                          : "bg-[#5c5c5c]"
                    }`}
                  />

                  {agent?.displayIcon ? (
                    <img
                      src={agent.displayIcon}
                      alt={agentLabel}
                      className="w-10 h-10 rounded-[10px] object-cover border border-[rgba(255,255,255,0.09)] bg-black shrink-0"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-10 h-10 rounded-[10px] border border-[rgba(255,255,255,0.09)] bg-black flex items-center justify-center text-xs text-[#5c5c5c] shrink-0">
                      {agentLabel.slice(0, 2)}
                    </div>
                  )}

                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[#ededed] truncate">
                        {mapLabel}
                      </span>
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full border shrink-0 ${
                          isWin
                            ? "text-[var(--semantic-win)] border-[var(--semantic-win-border)] bg-[var(--semantic-win-bg)]"
                            : isLoss
                              ? "text-[var(--semantic-loss)] border-[var(--semantic-loss-border)] bg-[var(--semantic-loss-bg)]"
                              : "text-[#8f8f8f] border-[rgba(255,255,255,0.09)]"
                        }`}
                      >
                        {isWin ? "勝利" : isLoss ? "敗北" : "引分"}
                      </span>
                    </div>

                    <div className="flex items-center gap-2 text-xs text-[#8f8f8f] mt-1">
                      <span className="truncate">{agentLabel}</span>
                      <span className="text-[#5c5c5c]">·</span>
                      <span className="truncate">{m.modeLabel}</span>
                      <span className="text-[#5c5c5c]">·</span>
                      <span className="font-num text-[#5c5c5c]">
                        {formatMatchDate(m.startedAtIso, m.startedAtTimestamp)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Right: Score / RR / KDA / Chevron */}
                <div className="flex items-center gap-6 sm:gap-8 shrink-0">
                  {/* Score + RR Change */}
                  <div className="text-right min-w-[68px]">
                    <div className="font-num text-sm font-semibold text-[#ededed]">
                      {m.myRoundsWon} <span className="text-[#5c5c5c]">-</span> {m.enemyRoundsWon}
                    </div>
                    <div className="font-num text-[11px] mt-0.5">
                      {m.rrChange !== null ? (
                        <span
                          className={
                            m.rrChange > 0
                              ? "text-[var(--semantic-win)]"
                              : m.rrChange < 0
                                ? "text-[var(--semantic-loss)]"
                                : "text-[#8f8f8f]"
                          }
                        >
                          {m.rrChange > 0 ? `+${m.rrChange}` : m.rrChange} RR
                        </span>
                      ) : (
                        <span className="text-[#5c5c5c]">—</span>
                      )}
                    </div>
                  </div>

                  {/* K/D/A */}
                  <div className="text-right min-w-[92px]">
                    <div className="font-num text-sm text-[#ededed]">
                      {m.kills} <span className="text-[#5c5c5c]">/</span> {m.deaths}{" "}
                      <span className="text-[#5c5c5c]">/</span> {m.assists}
                    </div>
                    <div className="font-num text-[11px] text-[#8f8f8f] mt-0.5">
                      K/D {kd}
                    </div>
                  </div>

                  {/* ACS & HS% (Desktop) */}
                  <div className="hidden lg:block text-right min-w-[68px]">
                    <div className="font-num text-sm text-[#ededed]">{m.acs} ACS</div>
                    <div className="font-num text-[11px] text-[#5c5c5c] mt-0.5">
                      HS {m.hsPercent.toFixed(0)}%
                    </div>
                  </div>

                  <ChevronRight className="w-4 h-4 text-[#5c5c5c] group-hover:text-[#ededed] transition-colors" />
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

import type { AgentStatItem, ValorantAssetsCatalog } from "../types/valorant";
import { resolveAgentAsset } from "../lib/valorantAssets";

interface AgentStatsTabProps {
  stats: AgentStatItem[];
  sampleSize: number;
  assets: ValorantAssetsCatalog;
  onOpenMatches: () => void;
}

export function AgentStatsTab({
  stats,
  sampleSize,
  assets,
  onOpenMatches,
}: AgentStatsTabProps) {
  const totalMatches = stats.reduce((sum, s) => sum + s.matches, 0);
  const topAgent = stats[0];
  const topAgentAsset = topAgent
    ? resolveAgentAsset(assets, topAgent.agentId, topAgent.agentName)
    : undefined;

  return (
    <div className="space-y-5 vt-animate-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-[#ededed]">エージェント別スタッツ</h2>
          <p className="text-xs text-[#8f8f8f] mt-0.5">
            直近に取得した {sampleSize} 試合（全モード）から集計
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenMatches}
          className="text-xs text-[#8f8f8f] hover:text-[#ededed] transition-colors cursor-pointer self-start sm:self-center shrink-0"
        >
          試合履歴を見る →
        </button>
      </div>

      {stats.length === 0 ? (
        <div className="vt-panel p-10 text-center text-sm text-[#8f8f8f]">
          エージェント別スタッツを集計できる試合がありません。
        </div>
      ) : (
        <div className="vt-panel overflow-hidden">
          {/* Summary strip */}
          <div className="px-5 py-4 flex flex-wrap items-center gap-x-8 gap-y-3 vt-hairline-b">
            <div>
              <div className="text-[11px] text-[#8f8f8f]">使用エージェント</div>
              <div className="font-num text-lg font-semibold text-[#ededed] mt-0.5">
                {stats.length}
                <span className="text-xs text-[#5c5c5c] ml-1.5">体</span>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[#8f8f8f]">集計試合</div>
              <div className="font-num text-lg font-semibold text-[#ededed] mt-0.5">
                {totalMatches}
              </div>
            </div>
            {topAgent && (
              <div className="min-w-0">
                <div className="text-[11px] text-[#8f8f8f]">最多使用</div>
                <div className="flex items-center gap-2 mt-0.5 min-w-0">
                  {topAgentAsset?.displayIcon && (
                    <img
                      src={topAgentAsset.displayIcon}
                      alt=""
                      className="w-5 h-5 rounded-[5px] object-cover border border-[rgba(255,255,255,0.09)] bg-black shrink-0"
                      loading="lazy"
                    />
                  )}
                  <span className="font-num text-sm font-semibold text-[#ededed] truncate">
                    {topAgent.agentName}
                  </span>
                  <span className="font-num text-[11px] text-[#5c5c5c] shrink-0">
                    {topAgent.matches}試合
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Column header */}
          <div className="hidden md:grid grid-cols-[minmax(0,1fr)_48px_80px_80px_56px] lg:grid-cols-[minmax(0,1fr)_48px_88px_88px_64px_64px_64px] gap-3 px-5 py-2.5 text-[11px] text-[#5c5c5c] vt-hairline-b">
            <span className="whitespace-nowrap">エージェント</span>
            <span className="text-right">試合</span>
            <span className="text-right">勝率</span>
            <span className="text-right whitespace-nowrap">W - L</span>
            <span className="text-right">K/D</span>
            <span className="hidden lg:block text-right">ACS</span>
            <span className="hidden lg:block text-right">HS%</span>
          </div>

          <div className="divide-y divide-[rgba(255,255,255,0.09)]">
            {stats.map((s) => {
              const agent = resolveAgentAsset(assets, s.agentId, s.agentName);
              const label = agent?.displayName || s.agentName;
              return (
                <div
                  key={s.agentId || s.agentName}
                  className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_48px_80px_80px_56px] lg:grid-cols-[minmax(0,1fr)_48px_88px_88px_64px_64px_64px] gap-3 items-center px-5 py-3 hover:bg-white/[0.025] transition-colors duration-150"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {agent?.displayIcon ? (
                      <img
                        src={agent.displayIcon}
                        alt={label}
                        className="w-9 h-9 rounded-[9px] object-cover border border-[rgba(255,255,255,0.09)] bg-black shrink-0"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-[9px] border border-[rgba(255,255,255,0.09)] bg-black flex items-center justify-center text-[11px] text-[#5c5c5c] shrink-0">
                        {label.slice(0, 2)}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="text-sm text-[#ededed] truncate">{label}</div>
                      <div className="font-num text-[11px] text-[#5c5c5c] mt-0.5 md:hidden">
                        {s.matches}試合 · {s.wins}W-{s.losses}L · K/D {s.kd.toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div className="hidden md:block font-num text-xs text-[#8f8f8f] text-right">
                    {s.matches}
                  </div>

                  <div className="hidden md:block text-right">
                    <div className="font-num text-xs text-[#ededed]">
                      {s.winRate.toFixed(1)}%
                    </div>
                    <div className="mt-1 h-0.5 w-full bg-white/[0.06] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#ededed]"
                        style={{ width: `${Math.max(0, Math.min(100, s.winRate))}%` }}
                      />
                    </div>
                  </div>

                  <div className="hidden md:block font-num text-xs text-right">
                    <span className="text-[var(--semantic-win)]">{s.wins}</span>
                    <span className="text-[#5c5c5c]"> - </span>
                    <span className="text-[var(--semantic-loss)]">{s.losses}</span>
                  </div>

                  <div className="hidden md:block font-num text-xs text-[#ededed] text-right">
                    {s.kd.toFixed(2)}
                  </div>
                  <div className="hidden lg:block font-num text-xs text-[#8f8f8f] text-right">
                    {s.avgAcs}
                  </div>
                  <div className="hidden lg:block font-num text-xs text-[#8f8f8f] text-right">
                    {s.hsPercent.toFixed(1)}
                    <span className="text-[#5c5c5c]">%</span>
                  </div>

                  <div className="md:hidden flex items-center gap-4 font-num text-xs">
                    <span className="text-[#ededed]">{s.winRate.toFixed(0)}%</span>
                    <span className="text-[#8f8f8f]">{s.avgAcs} ACS</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

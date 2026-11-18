import type { MapStatItem, ValorantAssetsCatalog } from "../types/valorant";
import { resolveMapAsset } from "../lib/valorantAssets";

interface MapStatsTabProps {
  stats: MapStatItem[];
  sampleSize: number;
  assets: ValorantAssetsCatalog;
  onOpenMatches: () => void;
}

export function MapStatsTab({ stats, sampleSize, assets, onOpenMatches }: MapStatsTabProps) {
  const totalMatches = stats.reduce((sum, s) => sum + s.matches, 0);
  const totalWins = stats.reduce((sum, s) => sum + s.wins, 0);
  const totalLosses = stats.reduce((sum, s) => sum + s.losses, 0);
  const decided = totalWins + totalLosses;
  const overallWinRate = decided > 0 ? (totalWins / decided) * 100 : 0;

  const bestMap = [...stats]
    .filter((s) => s.matches >= 2)
    .sort((a, b) => b.winRate - a.winRate || b.matches - a.matches)[0];

  return (
    <div className="space-y-5 vt-animate-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-medium text-[#ededed]">マップ別スタッツ</h2>
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
          マップ別スタッツを集計できる試合がありません。
        </div>
      ) : (
        <div className="vt-panel overflow-hidden">
          {/* Summary strip */}
          <div className="px-5 py-4 flex flex-wrap items-center gap-x-8 gap-y-3 vt-hairline-b">
            <div>
              <div className="text-[11px] text-[#8f8f8f]">プレイマップ</div>
              <div className="font-num text-lg font-semibold text-[#ededed] mt-0.5">
                {stats.length}
                <span className="text-xs text-[#5c5c5c] ml-1.5">面</span>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[#8f8f8f]">集計試合</div>
              <div className="font-num text-lg font-semibold text-[#ededed] mt-0.5">
                {totalMatches}
              </div>
            </div>
            <div>
              <div className="text-[11px] text-[#8f8f8f]">全体勝率</div>
              <div className="font-num text-lg font-semibold text-[#ededed] mt-0.5">
                {overallWinRate.toFixed(1)}
                <span className="text-xs text-[#5c5c5c]">%</span>
                <span className="font-num text-[11px] text-[#5c5c5c] ml-2">
                  <span className="text-[var(--semantic-win)]">{totalWins}W</span>
                  {" - "}
                  <span className="text-[var(--semantic-loss)]">{totalLosses}L</span>
                </span>
              </div>
            </div>
            {bestMap && (
              <div className="min-w-0">
                <div className="text-[11px] text-[#8f8f8f]">最高勝率（2試合以上）</div>
                <div className="flex items-center gap-2 mt-0.5 min-w-0">
                  <span className="text-sm font-semibold text-[#ededed] truncate">
                    {resolveMapAsset(assets, bestMap.mapId, bestMap.mapName)?.displayName ||
                      bestMap.mapName}
                  </span>
                  <span className="font-num text-[11px] text-[#5c5c5c] shrink-0">
                    {bestMap.winRate.toFixed(1)}%
                  </span>
                </div>
              </div>
            )}
          </div>

          {/* Column header */}
          <div className="hidden md:grid grid-cols-[minmax(0,1fr)_48px_80px_80px_56px] lg:grid-cols-[minmax(0,1fr)_48px_88px_88px_64px_64px] gap-3 px-5 py-2.5 text-[11px] text-[#5c5c5c] vt-hairline-b">
            <span>マップ</span>
            <span className="text-right">試合</span>
            <span className="text-right">勝率</span>
            <span className="text-right whitespace-nowrap">W - L</span>
            <span className="text-right">K/D</span>
            <span className="hidden lg:block text-right">ACS</span>
          </div>

          <div className="divide-y divide-[rgba(255,255,255,0.09)]">
            {stats.map((s) => {
              const mapAsset = resolveMapAsset(assets, s.mapId, s.mapName);
              const label = mapAsset?.displayName || s.mapName;
              return (
                <div
                  key={s.mapId || s.mapName}
                  className="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[minmax(0,1fr)_48px_80px_80px_56px] lg:grid-cols-[minmax(0,1fr)_48px_88px_88px_64px_64px] gap-3 items-center px-5 py-3 hover:bg-white/[0.025] transition-colors duration-150"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {mapAsset?.listViewIcon ? (
                      <img
                        src={mapAsset.listViewIcon}
                        alt={label}
                        className="w-11 h-9 rounded-[7px] object-cover border border-[rgba(255,255,255,0.09)] bg-black shrink-0 opacity-90"
                        loading="lazy"
                      />
                    ) : (
                      <div className="w-11 h-9 rounded-[7px] border border-[rgba(255,255,255,0.09)] bg-black shrink-0" />
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

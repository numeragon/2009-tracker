import type { ReactNode } from "react";
import type { PlayerProfileBundle, ValorantAssetsCatalog } from "../types/valorant";
import { resolveTierAsset } from "../lib/valorantAssets";

interface ProfileOverviewTabProps {
  profile: PlayerProfileBundle;
  assets: ValorantAssetsCatalog;
  rrChartNode?: ReactNode;
  onSwitchToMatches: () => void;
}

export function ProfileOverviewTab({
  profile,
  assets,
  rrChartNode,
  onSwitchToMatches,
}: ProfileOverviewTabProps) {
  const currentTierAsset = resolveTierAsset(assets, profile.currentRank.tierId);
  const peakTierAsset = profile.peakRank
    ? resolveTierAsset(assets, profile.peakRank.tierId)
    : undefined;

  const currentRankLabel =
    currentTierAsset?.tierName || profile.currentRank.tierName || "ランクなし";
  const peakRankLabel = profile.peakRank
    ? peakTierAsset?.tierName || profile.peakRank.tierName
    : "記録なし";

  const lastDelta = profile.currentRank.lastChange;
  const rrClamped = Math.max(0, Math.min(100, profile.currentRank.rr));
  const comp = profile.competitiveSummary;

  return (
    <div className="space-y-6 vt-animate-in">
      {/* Row 1: Current Rank / Peak Rank / Season Win-Loss */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Current Rank */}
        <div className="vt-panel p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#8f8f8f]">現在ランク</span>
            {lastDelta !== 0 && profile.currentRank.tierId > 0 && (
              <span
                className={`font-num text-[11px] px-2 py-0.5 rounded-full border ${
                  lastDelta > 0
                    ? "text-[var(--semantic-win)] border-[var(--semantic-win-border)] bg-[var(--semantic-win-bg)]"
                    : "text-[var(--semantic-loss)] border-[var(--semantic-loss-border)] bg-[var(--semantic-loss-bg)]"
                }`}
              >
                {lastDelta > 0 ? `+${lastDelta}` : lastDelta} RR
              </span>
            )}
          </div>

          <div className="flex items-center gap-4 my-4">
            {currentTierAsset?.largeIcon ? (
              <img
                src={currentTierAsset.largeIcon}
                alt={currentRankLabel}
                className="w-13 h-13 object-contain shrink-0"
              />
            ) : (
              <div className="w-12 h-12 rounded-full border border-[rgba(255,255,255,0.09)] bg-black flex items-center justify-center text-xs text-[#5c5c5c] shrink-0">
                —
              </div>
            )}

            <div className="min-w-0">
              <div className="text-base font-semibold text-[#ededed] truncate">
                {currentRankLabel}
              </div>
              <div className="font-num text-sm text-[#8f8f8f] mt-0.5">
                {profile.currentRank.rr} <span className="text-xs text-[#5c5c5c]">RR</span>
                {profile.currentRank.leaderboardRank && (
                  <span className="ml-2 text-xs text-[#ededed]">
                    #{profile.currentRank.leaderboardRank}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Minimal monochrome RR progress bar */}
          <div className="w-full h-1 bg-white/[0.06] rounded-full overflow-hidden">
            <div
              className="h-full bg-[#ededed] rounded-full transition-all duration-200"
              style={{ width: `${rrClamped}%` }}
            />
          </div>
        </div>

        {/* Peak Rank */}
        <div className="vt-panel p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#8f8f8f]">ピークランク</span>
            {profile.peakRank?.seasonShort && (
              <span className="font-num text-[11px] text-[#5c5c5c]">
                {profile.peakRank.seasonShort}
              </span>
            )}
          </div>

          <div className="flex items-center gap-4 my-4">
            {peakTierAsset?.largeIcon ? (
              <img
                src={peakTierAsset.largeIcon}
                alt={peakRankLabel}
                className="w-13 h-13 object-contain shrink-0"
              />
            ) : (
              <div className="w-12 h-12 rounded-full border border-[rgba(255,255,255,0.09)] bg-black flex items-center justify-center text-xs text-[#5c5c5c] shrink-0">
                —
              </div>
            )}

            <div className="min-w-0">
              <div className="text-base font-semibold text-[#ededed] truncate">
                {peakRankLabel}
              </div>
              <div className="text-xs text-[#8f8f8f] mt-0.5">
                {profile.peakRank?.seasonShort
                  ? `シーズン ${profile.peakRank.seasonShort}`
                  : "最高到達ティア"}
              </div>
            </div>
          </div>

          <div className="text-[11px] text-[#5c5c5c]">全期間キャリア最高記録</div>
        </div>

        {/* Season Record */}
        <div className="vt-panel p-5 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs text-[#8f8f8f]">シーズン戦績</span>
            {profile.seasonStats?.seasonShort && (
              <span className="font-num text-[11px] text-[#5c5c5c]">
                {profile.seasonStats.seasonShort}
              </span>
            )}
          </div>

          {profile.seasonStats ? (
            <>
              <div className="my-4">
                <div className="font-num text-2xl font-semibold text-[#ededed]">
                  {profile.seasonStats.winRate.toFixed(1)}%
                </div>
                <div className="font-num text-xs text-[#8f8f8f] mt-1 flex items-center gap-2">
                  <span className="text-[var(--semantic-win)]">{profile.seasonStats.wins}勝</span>
                  <span className="text-[#5c5c5c]">/</span>
                  <span className="text-[var(--semantic-loss)]">
                    {profile.seasonStats.losses}敗
                  </span>
                  <span className="text-[#5c5c5c]">（計 {profile.seasonStats.games} 試合）</span>
                </div>
              </div>

              <div className="w-full h-1 bg-white/[0.06] rounded-full overflow-hidden flex">
                <div
                  className="h-full bg-[var(--semantic-win)]"
                  style={{ width: `${Math.min(100, profile.seasonStats.winRate)}%` }}
                />
              </div>
            </>
          ) : (
            <div className="my-auto py-4">
              <p className="text-sm text-[#8f8f8f]">今シーズンのランク戦データなし</p>
            </div>
          )}
        </div>
      </div>

      {/* Row 2: Competitive Summary Stats (Recent up to 20 Competitive Matches) */}
      <section className="vt-panel p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 vt-hairline-b">
          <div>
            <h2 className="text-sm font-medium text-[#ededed]">サマリースタッツ</h2>
            <p className="text-xs text-[#8f8f8f] mt-0.5">
              直近のコンペティティブ {comp.matchesCount} 試合から集計
            </p>
          </div>

          <div className="flex items-center gap-4">
            <div className="font-num text-xs text-[#8f8f8f]">
              合計:{" "}
              <span className="text-[#ededed]">{comp.kills}</span> K{" "}
              <span className="text-[#5c5c5c]">/</span>{" "}
              <span className="text-[#ededed]">{comp.deaths}</span> D{" "}
              <span className="text-[#5c5c5c]">/</span>{" "}
              <span className="text-[#ededed]">{comp.assists}</span> A
            </div>
            <button
              type="button"
              onClick={onSwitchToMatches}
              className="text-xs text-[#8f8f8f] hover:text-[#ededed] transition-colors cursor-pointer"
            >
              履歴を見る →
            </button>
          </div>
        </div>

        {comp.matchesCount > 0 ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-6 pt-5">
            <div>
              <div className="text-xs text-[#8f8f8f]">K/D</div>
              <div className="font-num text-2xl font-semibold text-[#ededed] mt-1">
                {comp.kd.toFixed(2)}
              </div>
              <div className="font-num text-[11px] text-[#5c5c5c] mt-1">
                {comp.kills}K · {comp.deaths}D · {comp.assists}A
              </div>
            </div>

            <div>
              <div className="text-xs text-[#8f8f8f]">勝率</div>
              <div className="font-num text-2xl font-semibold text-[#ededed] mt-1">
                {comp.winRate.toFixed(1)}%
              </div>
              <div className="font-num text-[11px] text-[#5c5c5c] mt-1">
                <span className="text-[var(--semantic-win)]">{comp.wins}W</span>{" "}
                <span className="text-[var(--semantic-loss)]">{comp.losses}L</span>
                {comp.draws > 0 ? ` ${comp.draws}D` : ""}
              </div>
            </div>

            <div>
              <div className="text-xs text-[#8f8f8f]">HS%</div>
              <div className="font-num text-2xl font-semibold text-[#ededed] mt-1">
                {comp.hsPercent.toFixed(1)}%
              </div>
              <div className="text-[11px] text-[#5c5c5c] mt-1">ヘッドショット率</div>
            </div>

            <div>
              <div className="text-xs text-[#8f8f8f]">平均 ACS</div>
              <div className="font-num text-2xl font-semibold text-[#ededed] mt-1">
                {comp.avgAcs}
              </div>
              <div className="text-[11px] text-[#5c5c5c] mt-1">コンバットスコア</div>
            </div>

            <div>
              <div className="text-xs text-[#8f8f8f]">平均 ADR</div>
              <div className="font-num text-2xl font-semibold text-[#ededed] mt-1">
                {comp.avgAdr}
              </div>
              <div className="text-[11px] text-[#5c5c5c] mt-1">ダメージ / ラウンド</div>
            </div>
          </div>
        ) : (
          <div className="pt-6 pb-2 text-sm text-[#8f8f8f]">
            直近の試合にコンペティティブの記録がありません。
          </div>
        )}
      </section>

      {/* Row 3: RR History Chart slot */}
      {rrChartNode}
    </div>
  );
}

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { RrHistoryPoint, ValorantAssetsCatalog } from "../types/valorant";
import { resolveTierAsset } from "../lib/valorantAssets";

interface RrHistoryChartProps {
  points: RrHistoryPoint[];
  assets: ValorantAssetsCatalog;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: RrHistoryPoint }>;
  assets: ValorantAssetsCatalog;
}

function RrTooltip({ active, payload, assets }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const pt = payload[0].payload;
  const tierAsset = resolveTierAsset(assets, pt.tierId);
  const rankLabel = tierAsset?.tierName || pt.tierName;
  const delta = pt.rrChange;

  return (
    <div className="bg-[#0a0a0a] border border-[rgba(255,255,255,0.14)] rounded-[12px] px-3.5 py-2.5 text-xs">
      <div className="flex items-center justify-between gap-4">
        <span className="font-medium text-[#ededed]">{rankLabel}</span>
        <span className="font-num text-[#5c5c5c]">{pt.fullDate}</span>
      </div>
      <div className="flex items-baseline gap-2.5 mt-1.5">
        <span className="font-num text-base font-semibold text-[#ededed]">{pt.rr} RR</span>
        <span
          className={`font-num text-xs ${
            delta > 0
              ? "text-[var(--semantic-win)]"
              : delta < 0
                ? "text-[var(--semantic-loss)]"
                : "text-[#8f8f8f]"
          }`}
        >
          {delta > 0 ? `+${delta}` : delta} RR
        </span>
      </div>
      {pt.mapName && <div className="text-[11px] text-[#8f8f8f] mt-1">{pt.mapName}</div>}
    </div>
  );
}

export function RrHistoryChart({ points, assets }: RrHistoryChartProps) {
  const useEloScale = points.some((p) => p.elo > 0);
  const dataKey = useEloScale ? "elo" : "rr";

  const values = points.map((p) => (useEloScale ? p.elo : p.rr));
  const minVal = values.length > 0 ? Math.min(...values) : 0;
  const maxVal = values.length > 0 ? Math.max(...values) : 100;
  const pad = Math.max(15, Math.round((maxVal - minVal) * 0.2));

  return (
    <section className="vt-panel p-6">
      <div className="flex items-center justify-between gap-4 pb-4 vt-hairline-b">
        <div>
          <h2 className="text-sm font-medium text-[#ededed]">RR 推移</h2>
          <p className="text-xs text-[#8f8f8f] mt-0.5">
            直近 {points.length} 試合のランクレーティング変動
          </p>
        </div>
        {points.length > 0 && (
          <div className="font-num text-xs text-[#8f8f8f]">
            現在 <span className="text-[#ededed]">{points[points.length - 1].rr} RR</span>
          </div>
        )}
      </div>

      {points.length >= 2 ? (
        <div className="h-56 w-full pt-5">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={points} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
              <CartesianGrid
                stroke="rgba(255, 255, 255, 0.06)"
                strokeDasharray="3 3"
                vertical={false}
              />
              <XAxis
                dataKey="dateLabel"
                stroke="#5c5c5c"
                tick={{ fill: "#5c5c5c", fontSize: 11, fontFamily: "var(--font-mono)" }}
                tickLine={false}
                axisLine={{ stroke: "rgba(255, 255, 255, 0.09)" }}
              />
              <YAxis
                domain={[Math.max(0, minVal - pad), maxVal + pad]}
                stroke="#5c5c5c"
                tick={{ fill: "#5c5c5c", fontSize: 11, fontFamily: "var(--font-mono)" }}
                tickLine={false}
                axisLine={false}
                tickFormatter={(val: number) => (useEloScale ? `${val % 100}` : `${val}`)}
              />
              <Tooltip
                content={<RrTooltip assets={assets} />}
                cursor={{ stroke: "rgba(255, 255, 255, 0.16)", strokeWidth: 1 }}
              />
              <Line
                type="monotone"
                dataKey={dataKey}
                stroke="#ededed"
                strokeWidth={1.75}
                dot={{
                  r: 3,
                  fill: "#0a0a0a",
                  stroke: "#ededed",
                  strokeWidth: 1.5,
                }}
                activeDot={{
                  r: 4.5,
                  fill: "#ededed",
                  stroke: "#000000",
                  strokeWidth: 1.5,
                }}
                isAnimationActive={true}
                animationDuration={220}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="py-10 text-center text-sm text-[#8f8f8f]">
          グラフを表示するためのコンペティティブ履歴がまだありません。
        </div>
      )}
    </section>
  );
}

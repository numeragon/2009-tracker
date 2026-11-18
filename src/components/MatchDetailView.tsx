import { ArrowLeft, Clock } from "lucide-react";
import type {
  MatchDetailBundle,
  MatchDetailPlayer,
  ValorantAssetsCatalog,
} from "../types/valorant";
import {
  resolveAgentAsset,
  resolveMapAsset,
  resolveTierAsset,
} from "../lib/valorantAssets";

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}分${String(s).padStart(2, "0")}秒`;
}

function formatFullDateTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts) || ts <= 0) return iso || "—";
  return new Date(ts).toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatEndTypeJa(endType: string): string {
  const e = endType.toLowerCase();
  if (e.includes("eliminat")) return "殲滅";
  if (e.includes("defuse")) return "スパイク解除";
  if (e.includes("detonat") || e.includes("explode") || e.includes("bomb")) return "スパイク爆破";
  if (e.includes("time")) return "時間切れ";
  if (e.includes("surrender")) return "降参";
  return endType || "完了";
}

interface ScoreboardSectionProps {
  title: string;
  roundsWon?: number;
  hasWon?: boolean;
  isFriendlyTeam?: boolean;
  players: MatchDetailPlayer[];
  targetPuuid: string;
  targetName: string;
  targetTag: string;
  assets: ValorantAssetsCatalog;
  onSelectPlayer: (name: string, tag: string) => void;
}

function ScoreboardSection({
  title,
  roundsWon,
  hasWon,
  players,
  targetPuuid,
  targetName,
  targetTag,
  assets,
  onSelectPlayer,
}: ScoreboardSectionProps) {
  const isTarget = (p: MatchDetailPlayer) => {
    if (targetPuuid && p.puuid === targetPuuid) return true;
    return (
      p.name.trim().toLowerCase() === targetName.trim().toLowerCase() &&
      p.tag.trim().toLowerCase() === targetTag.trim().toLowerCase()
    );
  };

  return (
    <section className="vt-panel overflow-hidden">
      <div className="px-5 py-3.5 flex items-center justify-between vt-hairline-b bg-[#0a0a0a]">
        <div className="flex items-center gap-2.5">
          <h3 className="text-xs font-medium text-[#ededed]">{title}</h3>
          {hasWon !== undefined && (
            <span
              className={`text-[11px] px-2 py-0.5 rounded-full border ${
                hasWon
                  ? "text-[var(--semantic-win)] border-[var(--semantic-win-border)] bg-[var(--semantic-win-bg)]"
                  : "text-[#8f8f8f] border-[rgba(255,255,255,0.09)]"
              }`}
            >
              {hasWon ? "勝利チーム" : "敗北チーム"}
            </span>
          )}
        </div>
        {roundsWon !== undefined && (
          <div className="font-num text-xs text-[#8f8f8f]">
            獲得ラウンド <span className="text-[#ededed] font-semibold">{roundsWon}</span>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-[680px]">
          <thead>
            <tr className="text-[11px] text-[#5c5c5c] vt-hairline-b">
              <th className="py-2.5 pl-5 pr-3 font-normal">プレイヤー</th>
              <th className="py-2.5 px-3 font-normal">ランク</th>
              <th className="py-2.5 px-3 font-normal text-right">ACS</th>
              <th className="py-2.5 px-3 font-normal text-right">K / D / A</th>
              <th className="py-2.5 px-3 font-normal text-right">K/D</th>
              <th className="py-2.5 px-3 font-normal text-right">ADR</th>
              <th className="py-2.5 px-3 font-normal text-right">HS%</th>
              <th className="py-2.5 pl-3 pr-5 font-normal text-right">平均消費 / 装備</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[rgba(255,255,255,0.06)] text-xs">
            {players.map((p) => {
              const highlighted = isTarget(p);
              const agent = resolveAgentAsset(assets, p.agentId, p.agentName);
              const tier = resolveTierAsset(assets, p.tierId);
              const iconUrl = agent?.displayIcon || p.agentIconUrl;
              const agentLabel = agent?.displayName || p.agentName;
              const tierLabel = tier?.tierName || p.tierName;

              return (
                <tr
                  key={p.puuid || `${p.name}#${p.tag}`}
                  className={`transition-colors duration-150 ${
                    highlighted
                      ? "bg-white/[0.065]"
                      : "hover:bg-white/[0.025]"
                  }`}
                >
                  <td className="py-3 pl-5 pr-3">
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-0.5 h-7 rounded-full shrink-0 ${
                          highlighted ? "bg-[#ededed]" : "bg-transparent"
                        }`}
                      />
                      {iconUrl ? (
                        <img
                          src={iconUrl}
                          alt={agentLabel}
                          className="w-8 h-8 rounded-[8px] object-cover border border-[rgba(255,255,255,0.09)] bg-black shrink-0"
                          loading="lazy"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-[8px] border border-[rgba(255,255,255,0.09)] bg-black shrink-0" />
                      )}

                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => onSelectPlayer(p.name, p.tag)}
                            className="font-medium text-[#ededed] hover:underline truncate cursor-pointer text-left"
                          >
                            {p.name}
                            <span className="font-num text-[#8f8f8f] font-normal ml-0.5">
                              #{p.tag}
                            </span>
                          </button>
                          {highlighted && (
                            <span className="text-[10px] px-1.5 py-0.2 rounded border border-white/25 text-[#ededed] shrink-0">
                              YOU
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-[#5c5c5c] truncate">{agentLabel}</div>
                      </div>
                    </div>
                  </td>

                  <td className="py-3 px-3">
                    <div className="flex items-center gap-1.5">
                      {tier?.smallIcon && p.tierId > 0 ? (
                        <img
                          src={tier.smallIcon}
                          alt={tierLabel}
                          className="w-5 h-5 object-contain shrink-0"
                          loading="lazy"
                        />
                      ) : null}
                      <span className="text-[#8f8f8f] truncate max-w-[100px]">
                        {p.tierId > 0 ? tierLabel : "—"}
                      </span>
                    </div>
                  </td>

                  <td className="py-3 px-3 text-right font-num font-medium text-[#ededed]">
                    {p.acs}
                  </td>

                  <td className="py-3 px-3 text-right font-num text-[#ededed]">
                    {p.kills} <span className="text-[#5c5c5c]">/</span> {p.deaths}{" "}
                    <span className="text-[#5c5c5c]">/</span> {p.assists}
                  </td>

                  <td
                    className={`py-3 px-3 text-right font-num ${
                      p.kd >= 1.0 ? "text-[#ededed]" : "text-[#8f8f8f]"
                    }`}
                  >
                    {p.kd.toFixed(2)}
                  </td>

                  <td className="py-3 px-3 text-right font-num text-[#8f8f8f]">
                    {p.adr !== null ? p.adr : "—"}
                  </td>

                  <td className="py-3 px-3 text-right font-num text-[#8f8f8f]">
                    {p.hsPercent.toFixed(0)}%
                  </td>

                  <td className="py-3 pl-3 pr-5 text-right font-num text-[#8f8f8f]">
                    {p.avgSpent !== null ? (
                      <>
                        {p.avgSpent.toLocaleString()}
                        {p.avgLoadout !== null && (
                          <span className="text-[#5c5c5c]">
                            {" "}
                            / {p.avgLoadout.toLocaleString()}
                          </span>
                        )}
                      </>
                    ) : (
                      "—"
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

interface MatchDetailViewProps {
  detail: MatchDetailBundle;
  targetPuuid: string;
  targetName: string;
  targetTag: string;
  assets: ValorantAssetsCatalog;
  onBack: () => void;
  onSelectPlayer: (name: string, tag: string) => void;
}

export function MatchDetailView({
  detail,
  targetPuuid,
  targetName,
  targetTag,
  assets,
  onBack,
  onSelectPlayer,
}: MatchDetailViewProps) {
  const mapAsset = resolveMapAsset(assets, detail.mapId, detail.mapName);
  const mapLabel = mapAsset?.displayName || detail.mapName;

  const isTargetInRed = detail.teams.red.players.some(
    (p) =>
      (targetPuuid && p.puuid === targetPuuid) ||
      (p.name.toLowerCase() === targetName.toLowerCase() &&
        p.tag.toLowerCase() === targetTag.toLowerCase()),
  );
  const isTargetInBlue = detail.teams.blue.players.some(
    (p) =>
      (targetPuuid && p.puuid === targetPuuid) ||
      (p.name.toLowerCase() === targetName.toLowerCase() &&
        p.tag.toLowerCase() === targetTag.toLowerCase()),
  );

  const myTeamKey: "red" | "blue" = isTargetInRed ? "red" : "blue";
  const enemyTeamKey: "red" | "blue" = myTeamKey === "red" ? "blue" : "red";

  const firstTeam = detail.teams[myTeamKey];
  const secondTeam = detail.teams[enemyTeamKey];
  const hasTwoTeams =
    detail.teams.blue.players.length > 0 || detail.teams.red.players.length > 0;

  return (
    <div className="max-w-5xl mx-auto py-8 px-6 space-y-6 vt-animate-in">
      {/* Back button */}
      <div>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs text-[#8f8f8f] hover:text-[#ededed] transition-colors cursor-pointer"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>プロフィール・試合履歴に戻る</span>
        </button>
      </div>

      {/* Match Summary Header */}
      <div className="vt-panel relative overflow-hidden p-6">
        {mapAsset?.splash && (
          <div className="absolute inset-0 pointer-events-none opacity-[0.12]">
            <img
              src={mapAsset.splash}
              alt=""
              className="w-full h-full object-cover object-center"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-[#0a0a0a] via-[#0a0a0a]/85 to-[#0a0a0a]/60" />
          </div>
        )}

        <div className="relative flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-xl font-semibold tracking-tight text-[#ededed]">{mapLabel}</h1>
              <span className="text-xs px-2.5 py-0.5 rounded-full border border-[rgba(255,255,255,0.09)] bg-black/60 text-[#8f8f8f]">
                {detail.modeLabel}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-3 text-xs text-[#8f8f8f] mt-2">
              <span className="font-num">{formatFullDateTime(detail.startedAtIso)}</span>
              <span className="text-[#5c5c5c]">·</span>
              <span className="inline-flex items-center gap-1 font-num">
                <Clock className="w-3.5 h-3.5 text-[#5c5c5c]" />
                {formatDuration(detail.durationSeconds)}
              </span>
              {detail.cluster && (
                <>
                  <span className="text-[#5c5c5c]">·</span>
                  <span>{detail.cluster}</span>
                </>
              )}
            </div>
          </div>

          {hasTwoTeams && (
            <div className="flex items-center gap-4 self-start sm:self-center bg-black/70 border border-[rgba(255,255,255,0.09)] rounded-[12px] px-5 py-3">
              <div className="text-center">
                <div className="text-[10px] text-[#8f8f8f]">
                  {isTargetInBlue || isTargetInRed ? "自チーム" : "TEAM A"}
                </div>
                <div
                  className={`font-num text-2xl font-semibold ${
                    firstTeam.hasWon
                      ? "text-[var(--semantic-win)]"
                      : secondTeam.hasWon
                        ? "text-[var(--semantic-loss)]"
                        : "text-[#ededed]"
                  }`}
                >
                  {firstTeam.roundsWon}
                </div>
              </div>

              <div className="font-num text-lg text-[#5c5c5c]">:</div>

              <div className="text-center">
                <div className="text-[10px] text-[#8f8f8f]">
                  {isTargetInBlue || isTargetInRed ? "相手チーム" : "TEAM B"}
                </div>
                <div className="font-num text-2xl font-semibold text-[#ededed]">
                  {secondTeam.roundsWon}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Round-by-Round Timeline */}
      {detail.rounds.length > 0 && hasTwoTeams && (
        <section className="vt-panel p-5">
          <div className="flex items-center justify-between mb-3.5">
            <h2 className="text-xs font-medium text-[#ededed]">ラウンド推移</h2>
            <div className="flex items-center gap-4 text-[11px] text-[#8f8f8f]">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[var(--semantic-win)]" />
                {isTargetInBlue || isTargetInRed ? "自チーム取得" : "Blue 取得"}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-[var(--semantic-loss)]" />
                {isTargetInBlue || isTargetInRed ? "相手チーム取得" : "Red 取得"}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            {detail.rounds.map((r, idx) => {
              const winnerLower = r.winningTeam.toLowerCase();
              const wonByFirst = winnerLower === myTeamKey;
              const wonBySecond = winnerLower === enemyTeamKey;

              return (
                <div key={r.roundNumber} className="flex items-center gap-1.5 shrink-0">
                  {idx === 12 && (
                    <div
                      title="サイド交代"
                      className="h-8 w-[1px] bg-[rgba(255,255,255,0.18)] mx-1"
                    />
                  )}
                  <div
                    title={`R${r.roundNumber}: ${formatEndTypeJa(r.endType)}`}
                    className={`w-7 h-9 rounded-[8px] border flex flex-col items-center justify-center font-num text-[11px] ${
                      wonByFirst
                        ? "border-[var(--semantic-win-border)] bg-[var(--semantic-win-bg)] text-[var(--semantic-win)]"
                        : wonBySecond
                          ? "border-[var(--semantic-loss-border)] bg-[var(--semantic-loss-bg)] text-[var(--semantic-loss)]"
                          : "border-[rgba(255,255,255,0.09)] text-[#5c5c5c]"
                    }`}
                  >
                    <span>{r.roundNumber}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Scoreboards */}
      {hasTwoTeams ? (
        <div className="space-y-5">
          <ScoreboardSection
            title={
              isTargetInBlue || isTargetInRed
                ? `自チーム (${myTeamKey.toUpperCase()})`
                : `TEAM ${myTeamKey.toUpperCase()}`
            }
            roundsWon={firstTeam.roundsWon}
            hasWon={firstTeam.hasWon}
            players={firstTeam.players}
            targetPuuid={targetPuuid}
            targetName={targetName}
            targetTag={targetTag}
            assets={assets}
            onSelectPlayer={onSelectPlayer}
          />

          <ScoreboardSection
            title={
              isTargetInBlue || isTargetInRed
                ? `相手チーム (${enemyTeamKey.toUpperCase()})`
                : `TEAM ${enemyTeamKey.toUpperCase()}`
            }
            roundsWon={secondTeam.roundsWon}
            hasWon={secondTeam.hasWon}
            players={secondTeam.players}
            targetPuuid={targetPuuid}
            targetName={targetName}
            targetTag={targetTag}
            assets={assets}
            onSelectPlayer={onSelectPlayer}
          />
        </div>
      ) : (
        <ScoreboardSection
          title="全プレイヤースコアボード"
          players={detail.otherPlayers}
          targetPuuid={targetPuuid}
          targetName={targetName}
          targetTag={targetTag}
          assets={assets}
          onSelectPlayer={onSelectPlayer}
        />
      )}
    </div>
  );
}

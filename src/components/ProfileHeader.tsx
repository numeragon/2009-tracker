import { Pin, RefreshCw } from "lucide-react";
import type { PlayerProfileBundle } from "../types/valorant";

export type ProfileTab = "overview" | "matches";

interface ProfileHeaderProps {
  profile: PlayerProfileBundle;
  activeTab: ProfileTab;
  onChangeTab: (tab: ProfileTab) => void;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
}

export function ProfileHeader({
  profile,
  activeTab,
  onChangeTab,
  isFavorite,
  onToggleFavorite,
  onRefresh,
  isRefreshing,
}: ProfileHeaderProps) {
  return (
    <div className="vt-panel overflow-hidden">
      {/* Subtle Player Card Banner */}
      <div className="relative p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-5">
        {profile.cardWideUrl && (
          <div className="absolute inset-0 pointer-events-none opacity-[0.14]">
            <img
              src={profile.cardWideUrl}
              alt=""
              className="w-full h-full object-cover object-center"
              loading="lazy"
            />
            <div className="absolute inset-0 bg-gradient-to-r from-[#0a0a0a] via-[#0a0a0a]/80 to-transparent" />
          </div>
        )}

        <div className="relative flex items-center gap-4 min-w-0">
          {profile.cardSmallUrl ? (
            <img
              src={profile.cardSmallUrl}
              alt={`${profile.name}#${profile.tag}`}
              className="w-16 h-16 rounded-[12px] object-cover border border-[rgba(255,255,255,0.12)] shrink-0 bg-black"
            />
          ) : (
            <div className="w-16 h-16 rounded-[12px] border border-[rgba(255,255,255,0.09)] bg-black flex items-center justify-center font-num text-lg text-[#8f8f8f] shrink-0">
              {profile.name.slice(0, 2).toUpperCase()}
            </div>
          )}

          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5 flex-wrap">
              <h1 className="text-xl font-semibold tracking-tight text-[#ededed] truncate">
                {profile.name}
              </h1>
              <span className="font-num text-sm text-[#8f8f8f]">#{profile.tag}</span>
            </div>

            <div className="flex items-center gap-2.5 mt-1.5 text-xs text-[#8f8f8f]">
              <span className="font-num px-2 py-0.5 rounded-[8px] border border-[rgba(255,255,255,0.09)] bg-black/60 text-[#ededed]">
                Lv. {profile.accountLevel}
              </span>
              <span className="font-num uppercase text-[#5c5c5c]">
                {profile.region.toUpperCase()}
              </span>
            </div>
          </div>
        </div>

        <div className="relative flex items-center gap-2 self-end sm:self-center shrink-0">
          <button
            type="button"
            onClick={onToggleFavorite}
            title={isFavorite ? "お気に入りから解除" : "お気に入りにピン留め"}
            className={`inline-flex items-center gap-1.5 h-9 px-3.5 text-xs rounded-[12px] border transition-colors duration-150 cursor-pointer ${
              isFavorite
                ? "bg-white/[0.08] border-white/25 text-[#ededed]"
                : "bg-black/70 border-[rgba(255,255,255,0.09)] text-[#8f8f8f] hover:text-[#ededed] hover:border-[rgba(255,255,255,0.2)]"
            }`}
          >
            <Pin className={`w-3.5 h-3.5 ${isFavorite ? "fill-current" : ""}`} />
            <span>{isFavorite ? "ピン留め中" : "お気に入り"}</span>
          </button>

          <button
            type="button"
            onClick={onRefresh}
            disabled={isRefreshing}
            title="最新データを再取得"
            className="inline-flex items-center gap-1.5 h-9 px-3 text-xs rounded-[12px] border border-[rgba(255,255,255,0.09)] bg-black/70 text-[#8f8f8f] hover:text-[#ededed] hover:border-[rgba(255,255,255,0.2)] transition-colors duration-150 disabled:opacity-40 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
            <span className="hidden md:inline">更新</span>
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-6 flex items-center gap-6 vt-hairline-t bg-black/40">
        <button
          type="button"
          onClick={() => onChangeTab("overview")}
          className={`relative py-3 text-xs font-medium transition-colors duration-150 cursor-pointer ${
            activeTab === "overview" ? "text-[#ededed]" : "text-[#8f8f8f] hover:text-[#ededed]"
          }`}
        >
          概要
          {activeTab === "overview" && (
            <span className="absolute left-0 right-0 bottom-0 h-[1.5px] bg-[#ededed]" />
          )}
        </button>

        <button
          type="button"
          onClick={() => onChangeTab("matches")}
          className={`relative py-3 text-xs font-medium transition-colors duration-150 cursor-pointer flex items-center gap-1.5 ${
            activeTab === "matches" ? "text-[#ededed]" : "text-[#8f8f8f] hover:text-[#ededed]"
          }`}
        >
          <span>試合履歴</span>
          <span className="font-num text-[11px] text-[#5c5c5c]">{profile.matches.length}</span>
          {activeTab === "matches" && (
            <span className="absolute left-0 right-0 bottom-0 h-[1.5px] bg-[#ededed]" />
          )}
        </button>
      </div>
    </div>
  );
}

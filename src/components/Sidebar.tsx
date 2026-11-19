import { Crosshair, Disc, Film, Home, Pin, Radio, Settings, ShoppingBag, Trophy, X } from "lucide-react";
import type { Region, SavedPlayerEntry, ValorantAssetsCatalog } from "../types/valorant";
import { playerKey } from "../lib/storage";
import { resolveTierAsset } from "../lib/valorantAssets";
import { handleTitlebarMouseDown } from "./WindowControls";

export type AppRoute =
  | "home"
  | "live"
  | "crosshair"
  | "store"
  | "recorder"
  | "clips"
  | "profile"
  | "match-detail"
  | "leaderboard"
  | "settings";

interface SidebarProps {
  currentRoute: AppRoute;
  activePlayerKey: string | null;
  hasApiKey: boolean;
  isRecordingActive?: boolean;
  saveHotkeyLabel?: string;
  favorites: SavedPlayerEntry[];
  history: SavedPlayerEntry[];
  assets: ValorantAssetsCatalog;
  onNavigate: (
    route: "home" | "live" | "crosshair" | "store" | "recorder" | "clips" | "leaderboard" | "settings",
  ) => void;
  onSelectSavedPlayer: (name: string, tag: string, region: Region) => void;
  onRemoveFavorite: (entry: SavedPlayerEntry) => void;
  onRemoveHistory: (name: string, tag: string) => void;
  onClearHistory: () => void;
}

export function Sidebar({
  currentRoute,
  activePlayerKey,
  hasApiKey,
  isRecordingActive = false,
  saveHotkeyLabel,
  favorites,
  history,
  assets,
  onNavigate,
  onSelectSavedPlayer,
  onRemoveFavorite,
  onRemoveHistory,
  onClearHistory,
}: SidebarProps) {
  const navItems: Array<{
    id: "home" | "live" | "crosshair" | "store" | "recorder" | "clips" | "leaderboard" | "settings";
    label: string;
    icon: typeof Home;
    badge?: string;
    dot?: boolean;
    pulseDot?: boolean;
  }> = [
    { id: "home", label: "ホーム", icon: Home },
    { id: "live", label: "試合中（ライブ）", icon: Radio },
    { id: "crosshair", label: "クロスヘア", icon: Crosshair },
    { id: "store", label: "ショップ", icon: ShoppingBag },
    {
      id: "recorder",
      label: "録画・リプレイ",
      icon: Disc,
      badge: isRecordingActive ? saveHotkeyLabel : undefined,
      pulseDot: isRecordingActive,
    },
    { id: "clips", label: "クリップ編集", icon: Film },
    { id: "leaderboard", label: "リーダーボード", icon: Trophy },
    { id: "settings", label: "設定", icon: Settings, dot: !hasApiKey },
  ];

  return (
    <aside className="relative z-10 w-60 shrink-0 bg-[#0a0a0a]/82 backdrop-blur-md vt-hairline-r flex flex-col h-full select-none">
      {/* App Title (Pure #000000 unified draggable titlebar zone) */}
      <div
        data-tauri-drag-region
        onMouseDown={handleTitlebarMouseDown}
        className="h-14 px-5 flex items-center justify-between bg-[#000000] vt-hairline-b shrink-0"
      >
        <button
          type="button"
          onClick={() => onNavigate("home")}
          className="flex items-center gap-2.5 text-left cursor-pointer group"
        >
          <img
            src="/app-icon.png"
            alt="#2009 tracker"
            className="w-7 h-7 rounded-[8px] object-contain shrink-0 transition-transform duration-150 group-hover:scale-105"
          />
          <span className="text-sm tracking-tight flex items-baseline gap-1">
            <span className="font-num font-semibold text-[#ededed]">#2009</span>
            <span className="font-medium text-[#8f8f8f] group-hover:text-[#ededed] transition-colors">
              tracker
            </span>
          </span>
        </button>
      </div>

      {/* Primary Nav */}
      <nav className="p-3 space-y-1 vt-hairline-b shrink-0">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentRoute === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
              className={`w-full flex items-center justify-between px-3 py-2 rounded-[10px] text-xs transition-colors duration-150 cursor-pointer ${
                isActive
                  ? "bg-white/[0.07] text-[#ededed] font-medium"
                  : "text-[#8f8f8f] hover:text-[#ededed] hover:bg-white/[0.03]"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Icon className="w-4 h-4 shrink-0" />
                <span>{item.label}</span>
              </span>

              <span className="flex items-center gap-2">
                {item.pulseDot && (
                  <span
                    title="インスタントリプレイ録画中"
                    className="w-1.5 h-1.5 rounded-full bg-[#ededed] animate-pulse"
                  />
                )}
                {item.badge && (
                  <span className="font-num text-[10px] px-1.5 py-0.5 rounded border border-[rgba(255,255,255,0.09)] text-[#8f8f8f]">
                    {item.badge}
                  </span>
                )}
                {item.dot && (
                  <span
                    title="APIキー未設定"
                    className="w-1.5 h-1.5 rounded-full bg-[#ededed]"
                  />
                )}
              </span>
            </button>
          );
        })}
      </nav>

      {/* Scrollable Favorites & Search History */}
      <div className="flex-1 overflow-y-auto p-3 space-y-6">
        {/* Favorites */}
        <div>
          <div className="px-2 mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium text-[#5c5c5c] tracking-wide">
              お気に入り
            </span>
            {favorites.length > 0 && (
              <span className="font-num text-[10px] text-[#5c5c5c]">{favorites.length}</span>
            )}
          </div>

          {favorites.length === 0 ? (
            <p className="px-2 py-2 text-[11px] text-[#5c5c5c] leading-relaxed">
              プロフィール画面のピン留めで登録できます
            </p>
          ) : (
            <div className="space-y-0.5">
              {favorites.map((fav) => {
                const key = playerKey(fav.name, fav.tag, fav.region);
                const isSelected =
                  (currentRoute === "profile" || currentRoute === "match-detail") &&
                  activePlayerKey === key;
                const tierAsset = resolveTierAsset(assets, fav.tierId);

                return (
                  <div
                    key={key}
                    className={`group flex items-center justify-between rounded-[10px] px-2.5 py-1.5 transition-colors duration-150 ${
                      isSelected ? "bg-white/[0.07]" : "hover:bg-white/[0.03]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectSavedPlayer(fav.name, fav.tag, fav.region)}
                      className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
                    >
                      {tierAsset?.smallIcon && (fav.tierId ?? 0) > 0 ? (
                        <img
                          src={tierAsset.smallIcon}
                          alt=""
                          className="w-4 h-4 object-contain shrink-0"
                        />
                      ) : (
                        <Pin className="w-3.5 h-3.5 text-[#5c5c5c] shrink-0" />
                      )}
                      <div className="min-w-0 flex-1 truncate text-xs">
                        <span className="text-[#ededed]">{fav.name}</span>
                        <span className="font-num text-[#5c5c5c]">#{fav.tag}</span>
                      </div>
                    </button>

                    <button
                      type="button"
                      onClick={() => onRemoveFavorite(fav)}
                      title="ピン留め解除"
                      className="opacity-0 group-hover:opacity-100 p-1 text-[#5c5c5c] hover:text-[#ededed] transition-opacity cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Search History */}
        <div>
          <div className="px-2 mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium text-[#5c5c5c] tracking-wide">
              検索履歴
            </span>
            {history.length > 0 && (
              <button
                type="button"
                onClick={onClearHistory}
                className="text-[10px] text-[#5c5c5c] hover:text-[#ededed] transition-colors cursor-pointer"
              >
                消去
              </button>
            )}
          </div>

          {history.length === 0 ? (
            <p className="px-2 py-2 text-[11px] text-[#5c5c5c]">履歴はありません</p>
          ) : (
            <div className="space-y-0.5">
              {history.map((item) => {
                const key = playerKey(item.name, item.tag, item.region);
                const isSelected =
                  (currentRoute === "profile" || currentRoute === "match-detail") &&
                  activePlayerKey === key;

                return (
                  <div
                    key={key}
                    className={`group flex items-center justify-between rounded-[10px] px-2.5 py-1.5 transition-colors duration-150 ${
                      isSelected ? "bg-white/[0.07]" : "hover:bg-white/[0.03]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectSavedPlayer(item.name, item.tag, item.region)}
                      className="flex items-center justify-between gap-2 min-w-0 flex-1 text-left cursor-pointer"
                    >
                      <div className="min-w-0 truncate text-xs">
                        <span className="text-[#8f8f8f] group-hover:text-[#ededed] transition-colors">
                          {item.name}
                        </span>
                        <span className="font-num text-[#5c5c5c]">#{item.tag}</span>
                      </div>
                      <span className="font-num text-[10px] text-[#5c5c5c] uppercase shrink-0">
                        {item.region}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onRemoveHistory(item.name, item.tag)}
                      title="履歴から削除"
                      className="opacity-0 group-hover:opacity-100 p-1 ml-1 text-[#5c5c5c] hover:text-[#ededed] transition-opacity cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

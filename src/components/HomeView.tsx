import { KeyRound, Pin, History, Radio } from "lucide-react";
import type { Region, SavedPlayerEntry } from "../types/valorant";
import type { ApiClientError } from "../lib/errors";
import { ErrorBanner } from "./ErrorBanner";
import { SearchBar } from "./SearchBar";

interface HomeViewProps {
  region: Region;
  onRegionChange: (region: Region) => void;
  onSearch: (riotId: string, region: Region) => void;
  isLoading: boolean;
  hasApiKey: boolean;
  onOpenSettings: () => void;
  onOpenLiveMatch: () => void;
  favorites: SavedPlayerEntry[];
  history: SavedPlayerEntry[];
  onSelectSavedPlayer: (name: string, tag: string, region: Region) => void;
  error: ApiClientError | null;
  onRetry?: () => void;
}

export function HomeView({
  region,
  onRegionChange,
  onSearch,
  isLoading,
  hasApiKey,
  onOpenSettings,
  onOpenLiveMatch,
  favorites,
  history,
  onSelectSavedPlayer,
  error,
  onRetry,
}: HomeViewProps) {
  return (
    <div className="min-h-[calc(100vh-3.5rem)] flex flex-col items-center justify-center px-6 py-12 vt-animate-in">
      <div className="w-full max-w-xl space-y-8">
        {/* Heading */}
        <div className="text-center space-y-2.5">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-[rgba(255,255,255,0.09)] bg-[#0a0a0a]/80 text-[11px] text-[#8f8f8f] font-num">
            #2009 TRACKER · VALORANT STATS
          </div>
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-[#ededed]">
            プレイヤー戦績を検索
          </h1>
          <p className="text-sm text-[#8f8f8f]">
            Riot ID（名前#タグ）を入力して、ランク・スタッツ・直近の試合履歴を閲覧できます。
          </p>
        </div>

        {/* Hero Search Bar */}
        <div className="flex flex-col items-center gap-3">
          <SearchBar
            variant="hero"
            region={region}
            onRegionChange={onRegionChange}
            onSearch={onSearch}
            isLoading={isLoading}
          />
          <button
            type="button"
            onClick={onOpenLiveMatch}
            className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-[rgba(255,255,255,0.09)] bg-[#0a0a0a] hover:border-[rgba(255,255,255,0.22)] text-xs text-[#8f8f8f] hover:text-[#ededed] transition-colors cursor-pointer"
          >
            <Radio className="w-3.5 h-3.5 text-[var(--semantic-win)]" />
            <span>進行中の試合（ライブマッチ）を表示</span>
          </button>
        </div>

        {/* Inline Error if search triggered an error */}
        {error && (
          <ErrorBanner
            error={error}
            onRetry={onRetry}
            onOpenSettings={onOpenSettings}
          />
        )}

        {/* API Key missing prompt */}
        {!hasApiKey && !error && (
          <div className="vt-panel p-4 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <KeyRound className="w-4 h-4 text-[#8f8f8f] shrink-0" />
              <p className="text-xs text-[#8f8f8f]">
                検索を行うには、最初に HenrikDev APIキーを設定してください。
              </p>
            </div>
            <button
              type="button"
              onClick={onOpenSettings}
              className="h-8 px-3.5 rounded-[10px] bg-[#ededed] text-black text-xs font-medium hover:bg-white transition-colors shrink-0 cursor-pointer"
            >
              設定を開く
            </button>
          </div>
        )}

        {/* Quick Access Chips: Favorites & Recent History */}
        {(favorites.length > 0 || history.length > 0) && (
          <div className="space-y-4 pt-2">
            {favorites.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs text-[#5c5c5c]">
                  <Pin className="w-3 h-3" />
                  <span>お気に入り</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {favorites.slice(0, 6).map((p) => (
                    <button
                      key={`fav-${p.region}-${p.name}-${p.tag}`}
                      type="button"
                      onClick={() => onSelectSavedPlayer(p.name, p.tag, p.region)}
                      className="px-3 py-1.5 rounded-[10px] border border-[rgba(255,255,255,0.09)] bg-[#0a0a0a] hover:border-[rgba(255,255,255,0.22)] text-xs text-[#ededed] transition-colors cursor-pointer"
                    >
                      <span>{p.name}</span>
                      <span className="font-num text-[#8f8f8f]">#{p.tag}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {history.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 text-xs text-[#5c5c5c]">
                  <History className="w-3 h-3" />
                  <span>最近の検索</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {history.slice(0, 6).map((p) => (
                    <button
                      key={`hist-${p.region}-${p.name}-${p.tag}`}
                      type="button"
                      onClick={() => onSelectSavedPlayer(p.name, p.tag, p.region)}
                      className="px-3 py-1.5 rounded-[10px] border border-[rgba(255,255,255,0.09)] bg-[#0a0a0a] hover:border-[rgba(255,255,255,0.22)] text-xs text-[#8f8f8f] hover:text-[#ededed] transition-colors cursor-pointer"
                    >
                      <span>{p.name}</span>
                      <span className="font-num text-[#5c5c5c]">#{p.tag}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

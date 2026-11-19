import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AppSettings,
  MatchDetailBundle,
  MatchModeFilter,
  MatchSummaryItem,
  PlayerProfileBundle,
  Region,
  SavedPlayerEntry,
  ValorantAssetsCatalog,
} from "./types/valorant";
import { ApiClientError, normalizeError } from "./lib/errors";
import {
  clearSearchHistory,
  hydrateFromTauriStore,
  loadFavoritesSync,
  loadSearchHistorySync,
  loadSettingsSync,
  playerKey,
  pushSearchHistory,
  removeSearchHistoryItem,
  saveSettings,
  toggleFavoritePlayer,
  updateStoredPlayerMeta,
} from "./lib/storage";
import { loadValorantAssets } from "./lib/valorantAssets";
import { aggregateProfileStats } from "./lib/aggregateStats";
import {
  fetchFilteredMatches,
  fetchMatchDetail,
  fetchPlayerProfile,
  parseRiotId,
} from "./lib/henrikApi";
import { Sidebar, type AppRoute } from "./components/Sidebar";
import { SearchBar } from "./components/SearchBar";
import { HomeView } from "./components/HomeView";
import { SettingsView } from "./components/SettingsView";
import { LeaderboardView } from "./components/LeaderboardView";
import { ProfileHeader, type ProfileTab } from "./components/ProfileHeader";
import { ProfileOverviewTab } from "./components/ProfileOverviewTab";
import { AgentStatsTab } from "./components/AgentStatsTab";
import { MapStatsTab } from "./components/MapStatsTab";
import { RrHistoryChart } from "./components/RrHistoryChart";
import { MatchHistoryTab } from "./components/MatchHistoryTab";
import { MatchDetailView } from "./components/MatchDetailView";
import { LiveMatchView } from "./components/LiveMatchView";
import { CrosshairView } from "./components/CrosshairView";
import { StoreView } from "./components/StoreView";
import { RecorderView } from "./components/RecorderView";
import { ClipStudioView } from "./components/ClipStudioView";
import { WaveDotBackground, type WavePreset } from "./components/WaveDotBackground";
import { AutoUpdateBanner } from "./components/AutoUpdateBanner";
import { BootSplash } from "./components/BootSplash";
import { WindowControls, handleTitlebarMouseDown } from "./components/WindowControls";
import { ErrorBanner } from "./components/ErrorBanner";
import { MatchDetailSkeleton, ProfileSkeleton } from "./components/Skeletons";
import {
  onReplayClipSaved,
  onReplayNavigate,
  onReplayStateChanged,
  replayGetState,
} from "./lib/replayApi";

const EMPTY_ASSETS: ValorantAssetsCatalog = {
  agentsById: {},
  agentsByKey: {},
  mapsById: {},
  mapsByKey: {},
  tiersById: {},
  weaponsById: {},
};

export default function App() {
  const [settings, setSettings] = useState<AppSettings>(() => loadSettingsSync());
  const [searchRegion, setSearchRegion] = useState<Region>(() => loadSettingsSync().defaultRegion);
  const [history, setHistory] = useState<SavedPlayerEntry[]>(() => loadSearchHistorySync());
  const [favorites, setFavorites] = useState<SavedPlayerEntry[]>(() => loadFavoritesSync());
  const [assets, setAssets] = useState<ValorantAssetsCatalog>(EMPTY_ASSETS);

  const [route, setRoute] = useState<AppRoute>("home");
  const [profileTab, setProfileTab] = useState<ProfileTab>("overview");
  const [headerQuery, setHeaderQuery] = useState("");

  // Profile & Match list state
  const [profile, setProfile] = useState<PlayerProfileBundle | null>(null);
  const [isProfileLoading, setIsProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<ApiClientError | null>(null);
  const [lastSearchTarget, setLastSearchTarget] = useState<{
    name: string;
    tag: string;
    region: Region;
  } | null>(null);

  // Match mode filtering state
  const [modeFilter, setModeFilter] = useState<MatchModeFilter>("all");
  const [filteredMatches, setFilteredMatches] = useState<MatchSummaryItem[]>([]);
  const [isMatchesLoading, setIsMatchesLoading] = useState(false);
  const [matchesError, setMatchesError] = useState<ApiClientError | null>(null);

  // Match detail state
  const [selectedMatchSummary, setSelectedMatchSummary] = useState<MatchSummaryItem | null>(null);
  const [matchDetail, setMatchDetail] = useState<MatchDetailBundle | null>(null);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<ApiClientError | null>(null);

  // Boot splash & Instant Replay sidebar status & global clip toast
  const [showBootSplash, setShowBootSplash] = useState(true);
  const [isAppReady, setIsAppReady] = useState(false);
  const [bootEncoderName, setBootEncoderName] = useState<string | null>(null);
  const [isRecordingActive, setIsRecordingActive] = useState(false);
  const [saveHotkeyLabel, setSaveHotkeyLabel] = useState<string | undefined>(undefined);
  const [savedClipNotice, setSavedClipNotice] = useState<{
    title: string;
    path: string;
  } | null>(null);

  const searchReqIdRef = useRef(0);

  // Hydrate persistent Tauri store + valorant-api.com static assets + Replay status on startup
  useEffect(() => {
    const storePromise = hydrateFromTauriStore().then(
      ({ settings: s, history: h, favorites: f }) => {
        setSettings(s);
        setSearchRegion(s.defaultRegion);
        setHistory(h);
        setFavorites(f);
      },
    );

    const assetsPromise = loadValorantAssets().then((catalog) => {
      setAssets(catalog);
    });

    void Promise.allSettled([storePromise, assetsPromise]).then(() => {
      setIsAppReady(true);
    });

    const syncReplayBadge = () => {
      replayGetState()
        .then((st) => {
          setIsRecordingActive(st.config.enabled && !st.error);
          setSaveHotkeyLabel(st.hotkeyLabels.saveClip);
          setBootEncoderName(st.encoderName);
        })
        .catch(() => {});
    };
    syncReplayBadge();

    let active = true;
    const unsubs: Array<() => void> = [];
    void Promise.all([
      onReplayStateChanged(() => {
        if (active) syncReplayBadge();
      }),
      onReplayNavigate((nextRoute) => {
        if (active) setRoute(nextRoute);
      }),
      onReplayClipSaved((ev) => {
        if (!active) return;
        setSavedClipNotice({ title: ev.title, path: ev.path });
        window.setTimeout(() => {
          setSavedClipNotice((cur) => (cur?.path === ev.path ? null : cur));
        }, 4500);
      }),
    ]).then((fns) => {
      if (!active) fns.forEach((f) => f());
      else unsubs.push(...fns);
    });

    return () => {
      active = false;
      unsubs.forEach((f) => f());
    };
  }, []);

  const executePlayerSearch = useCallback(
    async (
      name: string,
      tag: string,
      region: Region,
      options?: { forceRefresh?: boolean; keepTab?: boolean },
    ) => {
      const reqId = ++searchReqIdRef.current;
      setHeaderQuery(`${name}#${tag}`);
      setSearchRegion(region);
      setLastSearchTarget({ name, tag, region });
      setProfileError(null);
      setMatchesError(null);

      if (!options?.keepTab) {
        setProfileTab("overview");
      }
      setModeFilter("all");
      setRoute("profile");
      setIsProfileLoading(true);

      try {
        const currentKey = settings.apiKey || loadSettingsSync().apiKey;
        const bundle = await fetchPlayerProfile(name, tag, region, currentKey, {
          forceRefresh: options?.forceRefresh,
        });

        if (reqId !== searchReqIdRef.current) return;

        setProfile(bundle);
        setFilteredMatches(bundle.matches);
        setHeaderQuery(`${bundle.name}#${bundle.tag}`);

        const entry: SavedPlayerEntry = {
          name: bundle.name,
          tag: bundle.tag,
          region: bundle.region,
          cardId: bundle.cardId,
          accountLevel: bundle.accountLevel,
          tierId: bundle.currentRank.tierId,
          tierName: bundle.currentRank.tierName,
          updatedAt: Date.now(),
        };
        const nextHistory = await pushSearchHistory(entry);
        const updated = await updateStoredPlayerMeta(entry);
        setHistory(updated.history.length > 0 ? updated.history : nextHistory);
        setFavorites(updated.favorites);
      } catch (err) {
        if (reqId !== searchReqIdRef.current) return;
        const normalized = normalizeError(err);
        setProfileError(normalized);
        if (!options?.forceRefresh) {
          setProfile(null);
        }
      } finally {
        if (reqId === searchReqIdRef.current) {
          setIsProfileLoading(false);
        }
      }
    },
    [settings.apiKey],
  );

  const handleSearchInput = useCallback(
    (riotIdInput: string, region: Region) => {
      try {
        const { name, tag } = parseRiotId(riotIdInput);
        void executePlayerSearch(name, tag, region);
      } catch (err) {
        const normalized = normalizeError(err);
        setProfileError(normalized);
        if (route !== "home") {
          setRoute("profile");
          setProfile(null);
        }
      }
    },
    [executePlayerSearch, route],
  );

  const handleChangeModeFilter = useCallback(
    async (nextMode: MatchModeFilter) => {
      setModeFilter(nextMode);
      setMatchesError(null);
      if (!profile) return;

      if (nextMode === "all") {
        setFilteredMatches(profile.matches);
        return;
      }

      setIsMatchesLoading(true);
      try {
        const currentKey = settings.apiKey || loadSettingsSync().apiKey;
        const list = await fetchFilteredMatches(profile, nextMode, currentKey);
        setFilteredMatches(list);
      } catch (err) {
        setMatchesError(normalizeError(err));
      } finally {
        setIsMatchesLoading(false);
      }
    },
    [profile, settings.apiKey],
  );

  const handleSelectMatch = useCallback(
    async (match: MatchSummaryItem) => {
      setSelectedMatchSummary(match);
      setMatchDetail(null);
      setDetailError(null);
      setRoute("match-detail");
      setIsDetailLoading(true);

      try {
        const currentKey = settings.apiKey || loadSettingsSync().apiKey;
        const detail = await fetchMatchDetail(match.matchId, currentKey, match.rawV4);
        setMatchDetail(detail);
      } catch (err) {
        setDetailError(normalizeError(err));
      } finally {
        setIsDetailLoading(false);
      }
    },
    [settings.apiKey],
  );

  const handleSaveSettings = async (next: AppSettings) => {
    const saved = await saveSettings(next);
    setSettings(saved);
    setSearchRegion(saved.defaultRegion);
  };

  const handleToggleFavorite = async () => {
    if (!profile) return;
    const entry: SavedPlayerEntry = {
      name: profile.name,
      tag: profile.tag,
      region: profile.region,
      cardId: profile.cardId,
      accountLevel: profile.accountLevel,
      tierId: profile.currentRank.tierId,
      tierName: profile.currentRank.tierName,
      updatedAt: Date.now(),
    };
    const nextFavs = await toggleFavoritePlayer(entry);
    setFavorites(nextFavs);
  };

  const isCurrentFavorite = profile
    ? favorites.some((f) => playerKey(f.name, f.tag) === playerKey(profile.name, profile.tag))
    : false;

  const activePlayerKey = profile
    ? playerKey(profile.name, profile.tag, profile.region)
    : lastSearchTarget
      ? playerKey(lastSearchTarget.name, lastSearchTarget.tag, lastSearchTarget.region)
      : null;

  const activeWavePreset: WavePreset =
    route === "profile"
      ? profileTab === "matches"
        ? "matches"
        : profileTab === "agents"
          ? "agents"
          : profileTab === "maps"
            ? "maps"
            : "overview"
      : route;

  const aggregatedStats = profile ? aggregateProfileStats(profile) : null;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#000000] text-[#ededed] flex ring-1 ring-inset ring-white/[0.08]">
      {/* Cinematic 3D Vortex & HUD Boot Loading Screen */}
      {showBootSplash && (
        <BootSplash
          ready={isAppReady}
          encoderName={bootEncoderName}
          onComplete={() => setShowBootSplash(false)}
        />
      )}

      {/* Interactive 3D Wave Dot Background across all tabs */}
      <WaveDotBackground preset={activeWavePreset} />

      {/* Left Sidebar */}
      <Sidebar
        currentRoute={route}
        activePlayerKey={activePlayerKey}
        hasApiKey={Boolean(settings.apiKey)}
        isRecordingActive={isRecordingActive}
        saveHotkeyLabel={saveHotkeyLabel}
        favorites={favorites}
        history={history}
        assets={assets}
        onNavigate={(nextRoute) => {
          setProfileError(null);
          setRoute(nextRoute);
        }}
        onSelectSavedPlayer={(name, tag, region) => {
          void executePlayerSearch(name, tag, region);
        }}
        onRemoveFavorite={async (entry) => {
          const next = await toggleFavoritePlayer(entry);
          setFavorites(next);
        }}
        onRemoveHistory={async (name, tag) => {
          const next = await removeSearchHistoryItem(name, tag);
          setHistory(next);
        }}
        onClearHistory={async () => {
          const next = await clearSearchHistory();
          setHistory(next);
        }}
      />

      {/* Right Column: Unified Pure-Black Custom Titlebar + Search Header + Main Content */}
      <div className="relative z-10 flex-1 flex flex-col min-w-0 h-full">
        {/* Persistent Top Search Bar + Frameless Pure-Black Window Controls */}
        <header
          data-tauri-drag-region
          onMouseDown={handleTitlebarMouseDown}
          className="h-14 pl-6 pr-0 flex items-center justify-between gap-4 vt-hairline-b bg-[#000000] shrink-0 select-none"
        >
          <SearchBar
            variant="header"
            initialQuery={headerQuery}
            region={searchRegion}
            onRegionChange={setSearchRegion}
            onSearch={handleSearchInput}
            isLoading={isProfileLoading}
          />

          <div className="flex items-center h-full gap-4 shrink-0">
            <div className="hidden md:flex items-center gap-2 text-[11px] text-[#5c5c5c] font-num pointer-events-none">
              <span>REGION: {searchRegion.toUpperCase()}</span>
            </div>
            <WindowControls />
          </div>
        </header>

        <AutoUpdateBanner />

        {/* Main Content */}
        <main className="flex-1 overflow-y-auto bg-transparent">
          {route === "home" && (
            <HomeView
              region={searchRegion}
              onRegionChange={setSearchRegion}
              onSearch={handleSearchInput}
              isLoading={isProfileLoading}
              hasApiKey={Boolean(settings.apiKey)}
              onOpenSettings={() => setRoute("settings")}
              onOpenLiveMatch={() => setRoute("live")}
              onOpenRecorder={() => setRoute("recorder")}
              favorites={favorites}
              history={history}
              onSelectSavedPlayer={(name, tag, region) => {
                void executePlayerSearch(name, tag, region);
              }}
              error={profileError}
              onRetry={
                lastSearchTarget
                  ? () =>
                      void executePlayerSearch(
                        lastSearchTarget.name,
                        lastSearchTarget.tag,
                        lastSearchTarget.region,
                      )
                  : undefined
              }
            />
          )}

          {route === "live" && (
            <LiveMatchView
              defaultRegion={searchRegion}
              apiKey={settings.apiKey || loadSettingsSync().apiKey}
              assets={assets}
              onSelectPlayer={(name, tag, region) => {
                void executePlayerSearch(name, tag, region);
              }}
            />
          )}

          {route === "crosshair" && <CrosshairView />}

          {route === "store" && <StoreView defaultRegion={searchRegion} />}

          {route === "recorder" && (
            <RecorderView onOpenClipStudio={() => setRoute("clips")} />
          )}

          {route === "clips" && <ClipStudioView />}

          {route === "settings" && (
            <SettingsView settings={settings} onSaveSettings={handleSaveSettings} />
          )}

          {route === "leaderboard" && (
            <LeaderboardView
              defaultRegion={searchRegion}
              apiKey={settings.apiKey || loadSettingsSync().apiKey}
              assets={assets}
              favorites={favorites}
              history={history}
              onSelectPlayer={(name, tag, region) => {
                void executePlayerSearch(name, tag, region);
              }}
              onOpenSettings={() => setRoute("settings")}
            />
          )}

          {route === "profile" && (
            <>
              {isProfileLoading ? (
                <ProfileSkeleton />
              ) : (
                <div className="max-w-5xl mx-auto py-8 px-6 space-y-6">
                  {profileError && (
                    <ErrorBanner
                      error={profileError}
                      onOpenSettings={() => setRoute("settings")}
                      onRetry={
                        lastSearchTarget
                          ? () =>
                              void executePlayerSearch(
                                lastSearchTarget.name,
                                lastSearchTarget.tag,
                                lastSearchTarget.region,
                                { forceRefresh: true },
                              )
                          : undefined
                      }
                    />
                  )}

                  {profile && (
                    <>
                      <ProfileHeader
                        profile={profile}
                        activeTab={profileTab}
                        onChangeTab={(tab) => setProfileTab(tab)}
                        agentCount={aggregatedStats?.agents.length ?? 0}
                        mapCount={aggregatedStats?.maps.length ?? 0}
                        isFavorite={isCurrentFavorite}
                        onToggleFavorite={handleToggleFavorite}
                        onRefresh={() =>
                          void executePlayerSearch(profile.name, profile.tag, profile.region, {
                            forceRefresh: true,
                            keepTab: true,
                          })
                        }
                        isRefreshing={isProfileLoading}
                      />

                      {profileTab === "overview" && (
                        <ProfileOverviewTab
                          profile={profile}
                          assets={assets}
                          onSwitchToMatches={() => setProfileTab("matches")}
                          rrChartNode={
                            <RrHistoryChart points={profile.rrHistory} assets={assets} />
                          }
                        />
                      )}

                      {profileTab === "matches" && (
                        <MatchHistoryTab
                          matches={filteredMatches}
                          modeFilter={modeFilter}
                          onChangeModeFilter={handleChangeModeFilter}
                          isLoading={isMatchesLoading}
                          error={matchesError}
                          onRetry={() => void handleChangeModeFilter(modeFilter)}
                          onOpenSettings={() => setRoute("settings")}
                          onSelectMatch={handleSelectMatch}
                          assets={assets}
                        />
                      )}

                      {profileTab === "agents" && aggregatedStats && (
                        <AgentStatsTab
                          stats={aggregatedStats.agents}
                          sampleSize={aggregatedStats.sampleSize}
                          assets={assets}
                          onOpenMatches={() => setProfileTab("matches")}
                        />
                      )}

                      {profileTab === "maps" && aggregatedStats && (
                        <MapStatsTab
                          stats={aggregatedStats.maps}
                          sampleSize={aggregatedStats.sampleSize}
                          assets={assets}
                          onOpenMatches={() => setProfileTab("matches")}
                        />
                      )}
                    </>
                  )}
                </div>
              )}
            </>
          )}

          {route === "match-detail" && (
            <>
              {isDetailLoading ? (
                <MatchDetailSkeleton />
              ) : detailError ? (
                <div className="max-w-5xl mx-auto py-8 px-6 space-y-4">
                  <button
                    type="button"
                    onClick={() => {
                      setRoute("profile");
                      setProfileTab("matches");
                    }}
                    className="text-xs text-[#8f8f8f] hover:text-[#ededed] transition-colors cursor-pointer"
                  >
                    ← 試合履歴に戻る
                  </button>
                  <ErrorBanner
                    error={detailError}
                    onOpenSettings={() => setRoute("settings")}
                    onRetry={
                      selectedMatchSummary
                        ? () => void handleSelectMatch(selectedMatchSummary)
                        : undefined
                    }
                  />
                </div>
              ) : matchDetail ? (
                <MatchDetailView
                  detail={matchDetail}
                  targetPuuid={profile?.puuid ?? ""}
                  targetName={profile?.name ?? lastSearchTarget?.name ?? ""}
                  targetTag={profile?.tag ?? lastSearchTarget?.tag ?? ""}
                  assets={assets}
                  onBack={() => {
                    setRoute("profile");
                    setProfileTab("matches");
                  }}
                  onSelectPlayer={(pName, pTag) => {
                    void executePlayerSearch(pName, pTag, searchRegion);
                  }}
                />
              ) : null}
            </>
          )}
        </main>

        {/* Global Floating Clip-Saved Toast (shown outside Recorder tab) */}
        {savedClipNotice && route !== "recorder" && (
          <div className="fixed bottom-5 right-5 z-40 rounded-[12px] bg-[#111111]/95 backdrop-blur-md vt-hairline px-4 py-3 flex items-center gap-3 text-xs text-[#ededed]">
            <span className="w-2 h-2 rounded-full bg-[#ededed]" />
            <span>クリップ保存完了: {savedClipNotice.title}</span>
            <button
              type="button"
              onClick={() => {
                setSavedClipNotice(null);
                setRoute("clips");
              }}
              className="px-2.5 py-1 rounded-[7px] bg-[#ededed] text-[#0a0a0a] text-[11px] font-medium hover:bg-white cursor-pointer"
            >
              編集を開く
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

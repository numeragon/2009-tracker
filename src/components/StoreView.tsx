import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Clock,
  Loader2,
  LogIn,
  LogOut,
  RefreshCw,
  ShoppingBag,
  Sparkles,
  UserPlus,
  UserRound,
  Wallet,
  X,
} from "lucide-react";
import type {
  Region,
  RiotSession,
  StoreCatalog,
  StorefrontViewData,
} from "../types/valorant";
import {
  clearRiotSessionInBackend,
  fetchLastRiotSession,
  fetchStorefrontFromClient,
  loadRiotAccountStore,
  onRiotLoginResult,
  parseStorefront,
  removeRiotSession,
  saveRiotSession,
  setActiveRiotSession,
  startRiotLogin,
  type RiotAccountStore,
} from "../lib/localClientApi";
import { loadStoreCatalog, resolveStoreSkin } from "../lib/storeCatalog";

interface StoreViewProps {
  defaultRegion: Region;
}

const EMPTY_CATALOG: StoreCatalog = {
  skinsByLevelId: {},
  skinsById: {},
  bundlesById: {},
};

function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(
    s,
  ).padStart(2, "0")}`;
}

function formatPrice(value: number): string {
  return `${Math.round(value).toLocaleString("ja-JP")} VP`;
}

function priceRemaining(fetchedAt: number, seconds: number, now: number): number {
  return Math.max(0, Math.round((fetchedAt + seconds * 1000 - now) / 1000));
}

export function StoreView({ defaultRegion }: StoreViewProps) {
  const [accounts, setAccounts] = useState<RiotAccountStore>(() => loadRiotAccountStore());
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const pendingLoginMode = useRef<"persistent" | "fresh">("persistent");

  const session: RiotSession | null =
    accounts.sessions.find((item) => item.puuid === accounts.activePuuid) ??
    accounts.sessions[0] ??
    null;
  const applyStore = useCallback((store: RiotAccountStore) => {
    setAccounts(store);
  }, []);

  const [loginPending, setLoginPending] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<(StorefrontViewData & { fetchedAt: number }) | null>(
    null,
  );
  const [catalog, setCatalog] = useState<StoreCatalog>(EMPTY_CATALOG);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setAccountMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [accountMenuOpen]);

  // Listen for the result of the embedded Riot login window.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void onRiotLoginResult((result) => {
      if (disposed) return;
      setLoginPending(false);
      if (result.status === "ok" && result.session) {
        const store = saveRiotSession({
          ...result.session,
          loginMode: pendingLoginMode.current,
        });
        applyStore(store);
        setAuthExpired(false);
        setError(null);
        setLoginError(null);
      } else {
        setLoginError(result.message ?? "ログインに失敗しました。");
      }
    }).then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    }).catch(() => {
      // Event bridge unavailable (e.g. browser preview); ignore.
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [applyStore]);

  // If the page missed the login event (e.g. the tab changed while the Riot
  // window was open), recover the in-memory session from the Rust side.
  useEffect(() => {
    if (accounts.sessions.length > 0) return;
    let cancelled = false;
    void fetchLastRiotSession().then((restored) => {
      if (!cancelled && restored) {
        applyStore(saveRiotSession(restored));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [accounts.sessions.length, applyStore]);

  const beginLogin = useCallback(async (fresh = false) => {
    pendingLoginMode.current = fresh ? "fresh" : "persistent";
    setLoginError(null);
    setLoginPending(true);
    try {
      await startRiotLogin(fresh);
    } catch (err) {
      setLoginPending(false);
      setLoginError(
        err instanceof Error ? err.message : "ログインウィンドウを開けませんでした。",
      );
    }
  }, []);

  const resetStoreData = useCallback(() => {
    setData(null);
    setError(null);
    setAuthExpired(false);
    setLoginError(null);
  }, []);

  const logout = useCallback(() => {
    if (!session) return;
    const store = removeRiotSession(session.puuid);
    applyStore(store);
    if (store.sessions.length === 0) void clearRiotSessionInBackend();
    resetStoreData();
    setAccountMenuOpen(false);
  }, [applyStore, resetStoreData, session]);

  const switchAccount = useCallback(
    (puuid: string) => {
      applyStore(setActiveRiotSession(puuid));
      resetStoreData();
      setAccountMenuOpen(false);
    },
    [applyStore, resetStoreData],
  );

  const removeAccount = useCallback(
    (puuid: string) => {
      const store = removeRiotSession(puuid);
      applyStore(store);
      if (store.sessions.length === 0) {
        void clearRiotSessionInBackend();
        setAccountMenuOpen(false);
      }
      resetStoreData();
    },
    [applyStore, resetStoreData],
  );

  const refresh = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchStorefrontFromClient(defaultRegion, session);

      if (result.authExpired) {
        setAuthExpired(true);
        setData(null);
        return;
      }

      if (!result.ok || !result.storefront) {
        setData(null);
        setError(result.message ?? "ストア情報を取得できませんでした。");
        return;
      }

      const parsed = parseStorefront(result.storefront, result.wallet);
      if (!parsed) {
        setData(null);
        setError("ストア情報の解析に失敗しました。時間をおいて再取得してください。");
        return;
      }

      setData({ ...parsed, fetchedAt: result.fetchedAt });
    } catch (err) {
      setData(null);
      setError(
        err instanceof Error
          ? `ストア情報の取得に失敗しました: ${err.message}`
          : "ストア情報の取得に失敗しました。",
      );
    } finally {
      setLoading(false);
    }
  }, [defaultRegion, session]);

  useEffect(() => {
    if (session) void refresh();
  }, [refresh, session]);

  // The skin catalog comes from a public API and can be slow; never block the
  // store itself on it.
  useEffect(() => {
    let cancelled = false;
    void loadStoreCatalog().then((loaded) => {
      if (!cancelled) {
        setCatalog(loaded);
        setCatalogLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const dailyTime = data
    ? formatDuration(priceRemaining(data.fetchedAt, data.dailyRemainingSeconds, now))
    : "--:--:--";
  const nightTime = data?.nightMarket
    ? formatDuration(priceRemaining(data.fetchedAt, data.nightMarket.remainingSeconds, now))
    : "--:--:--";
  const bundleTime = data?.bundle
    ? formatDuration(priceRemaining(data.fetchedAt, data.bundle.remainingSeconds, now))
    : "--:--:--";

  const bundleAsset = data?.bundle
    ? catalog.bundlesById[data.bundle.dataAssetId]
    : undefined;

  const itemLabel = (name?: string) =>
    name ?? (catalogLoading ? "読み込み中…" : "アイテム情報なし");

  const accountName =
    session && (session.gameName || session.tagLine)
      ? `${session.gameName}${session.tagLine ? `#${session.tagLine}` : ""}`
      : "Riotアカウント";

  return (
    <div className="max-w-5xl mx-auto py-8 px-6 space-y-6 vt-animate-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <ShoppingBag className="w-4 h-4 text-[#8f8f8f]" />
            <h1 className="text-xl font-semibold tracking-tight text-[#ededed]">
              ショップ
            </h1>
          </div>
          <p className="text-xs text-[#8f8f8f] mt-1.5">
            Riotアカウントでログインして、ゲームを起動していなくてもデイリーストア・ナイトマーケット・バンドルを確認できます。複数のアカウントを追加して切り替えられます。
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-center shrink-0">
          {session && (
            <div ref={accountMenuRef} className="relative">
              <div className="flex items-center gap-1 h-9 pl-3 pr-1.5 rounded-[12px] border border-[rgba(255,255,255,0.09)] bg-[#0a0a0a] text-[11px] max-w-[240px]">
                <button
                  type="button"
                  onClick={() => setAccountMenuOpen((open) => !open)}
                  className="flex items-center gap-2 min-w-0 cursor-pointer"
                  aria-haspopup="menu"
                  aria-expanded={accountMenuOpen}
                  title="アカウントを切り替え"
                >
                  <UserRound className="w-3.5 h-3.5 text-[#5c5c5c] shrink-0" />
                  <span className="text-[#ededed] truncate">{accountName}</span>
                  <ChevronDown
                    className={`w-3 h-3 text-[#5c5c5c] shrink-0 transition-transform duration-150 ${
                      accountMenuOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>
                <button
                  type="button"
                  title="このアカウントからログアウト"
                  onClick={logout}
                  className="p-1 rounded text-[#5c5c5c] hover:text-[#ededed] cursor-pointer shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>

              {accountMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 top-full mt-1.5 w-64 rounded-[12px] border border-[rgba(255,255,255,0.09)] bg-[#0a0a0a] p-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.65)] z-30 vt-animate-in"
                >
                  <p className="px-2 py-1 text-[10px] tracking-wide text-[#5c5c5c]">
                    アカウント
                  </p>
                  {accounts.sessions.map((account) => {
                    const active = account.puuid === session.puuid;
                    const name =
                      `${account.gameName}${
                        account.tagLine ? `#${account.tagLine}` : ""
                      }` || "Riotアカウント";
                    return (
                      <div
                        key={account.puuid}
                        className={`flex items-center gap-1 rounded-[8px] pr-0.5 ${
                          active ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => switchAccount(account.puuid)}
                          className="flex-1 flex items-center gap-2 min-w-0 h-9 px-2 text-left cursor-pointer"
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                              active ? "bg-[#ededed]" : "bg-[#3a3a3a]"
                            }`}
                          />
                          <span
                            className={`text-[11px] truncate ${
                              active ? "text-[#ededed]" : "text-[#8f8f8f]"
                            }`}
                          >
                            {name}
                          </span>
                          {active && (
                            <Check className="w-3 h-3 text-[#8f8f8f] ml-auto shrink-0" />
                          )}
                        </button>
                        <button
                          type="button"
                          title="このアカウントを削除"
                          onClick={() => removeAccount(account.puuid)}
                          className="p-1 rounded text-[#5c5c5c] hover:text-[#ededed] cursor-pointer shrink-0"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    );
                  })}
                  <div className="my-1 border-t border-[rgba(255,255,255,0.06)]" />
                  <button
                    type="button"
                    onClick={() => {
                      setAccountMenuOpen(false);
                      void beginLogin(true);
                    }}
                    disabled={loginPending}
                    className="w-full flex items-center gap-2 h-9 px-2 rounded-[8px] text-[11px] text-[#ededed] hover:bg-white/[0.04] disabled:opacity-50 cursor-pointer"
                  >
                    <UserPlus className="w-3.5 h-3.5 text-[#8f8f8f]" />
                    別のアカウントを追加
                  </button>
                </div>
              )}
            </div>
          )}

          {data && (data.vp !== null || data.rp !== null) && (
            <div className="flex items-center gap-2 h-9 px-3 rounded-[12px] border border-[rgba(255,255,255,0.09)] bg-[#0a0a0a] text-[11px]">
              <Wallet className="w-3.5 h-3.5 text-[#5c5c5c]" />
              {data.vp !== null && (
                <span className="font-num text-[#ededed]">
                  {data.vp.toLocaleString("ja-JP")}
                  <span className="text-[#5c5c5c] ml-1">VP</span>
                </span>
              )}
              {data.rp !== null && (
                <span className="font-num text-[#8f8f8f]">
                  {data.rp.toLocaleString("ja-JP")}
                  <span className="text-[#5c5c5c] ml-1">RP</span>
                </span>
              )}
            </div>
          )}

          {session && (
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 h-9 px-4 text-xs font-medium rounded-[12px] bg-[#ededed] text-black hover:bg-white transition-colors duration-150 disabled:opacity-50 cursor-pointer"
            >
              {loading ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5" />
              )}
              <span>再取得</span>
            </button>
          )}
        </div>
      </div>

      {!session && (
        <section className="vt-panel p-8 max-w-xl space-y-4">
          <div className="w-10 h-10 rounded-[12px] border border-[rgba(255,255,255,0.09)] bg-black flex items-center justify-center">
            <LogIn className="w-4 h-4 text-[#8f8f8f]" />
          </div>
          <div className="space-y-1.5">
            <h2 className="text-sm font-medium text-[#ededed]">
              Riotアカウントでログイン
            </h2>
            <p className="text-xs text-[#8f8f8f] leading-relaxed">
              Riotのログインページが専用ウィンドウで開きます。ログインすると、VALORANT
              を起動していなくてもストアを取得できます。
            </p>
            <p className="text-[11px] text-[#5c5c5c] leading-relaxed">
              パスワードがこのアプリに保存されることはありません。ログイン状態はRiotのページ側で管理され、次回は自動的に再利用されます。
            </p>
          </div>

          {loginError && (
            <p className="text-[11px] text-[var(--semantic-loss)] leading-relaxed">
              {loginError}
            </p>
          )}

          <button
            type="button"
            onClick={() => void beginLogin()}
            disabled={loginPending}
            className="inline-flex items-center gap-2 h-9 px-4 text-xs font-medium rounded-[12px] bg-[#ededed] text-black hover:bg-white transition-colors duration-150 disabled:opacity-50 cursor-pointer"
          >
            {loginPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <LogIn className="w-3.5 h-3.5" />
            )}
            <span>{loginPending ? "ログイン待機中…" : "ログイン"}</span>
          </button>
        </section>
      )}

      {session && authExpired && (
        <div className="vt-panel p-5 space-y-3">
          <p className="text-xs text-[#ededed]">
            Riotセッションの有効期限が切れました。
          </p>
          <p className="text-[11px] text-[#8f8f8f] leading-relaxed">
            再ログインするとストアを取得できます。Riotのログイン状態が残っていれば、ウィンドウは自動的に閉じます。
          </p>
          {loginError && (
            <p className="text-[11px] text-[var(--semantic-loss)]">{loginError}</p>
          )}
          <button
            type="button"
            onClick={() => void beginLogin(session.loginMode === "fresh")}
            disabled={loginPending}
            className="inline-flex items-center gap-1.5 h-9 px-4 text-xs font-medium rounded-[12px] bg-[#ededed] text-black hover:bg-white transition-colors duration-150 disabled:opacity-50 cursor-pointer"
          >
            {loginPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <LogIn className="w-3.5 h-3.5" />
            )}
            <span>{loginPending ? "ログイン待機中…" : "再ログイン"}</span>
          </button>
        </div>
      )}

      {session && error && !authExpired && (
        <div className="vt-panel p-5 space-y-2">
          <p className="text-xs text-[#8f8f8f] leading-relaxed">{error}</p>
          <p className="text-[11px] text-[#5c5c5c] leading-relaxed">
            ストアの反映には、ゲーム内で一度ストアを開く必要がある場合があります。時間をおいて再取得してください。
          </p>
        </div>
      )}

      {session && loading && !data && !authExpired && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="vt-panel p-4 space-y-3">
              <div className="h-24 vt-skeleton rounded-[10px]" />
              <div className="h-3 w-3/4 vt-skeleton" />
              <div className="h-3 w-1/3 vt-skeleton" />
            </div>
          ))}
        </div>
      )}

      {session && data && !authExpired && (
        <>
          {/* Daily store */}
          <section className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-medium text-[#ededed]">デイリーストア</h2>
                <span className="font-num text-[10px] text-[#5c5c5c]">
                  {data.daily.length} ITEMS
                </span>
              </div>
              <span className="inline-flex items-center gap-1.5 font-num text-[11px] text-[#8f8f8f]">
                <Clock className="w-3 h-3 text-[#5c5c5c]" />
                リセットまで {dailyTime}
              </span>
            </div>

            {data.daily.length === 0 ? (
              <div className="vt-panel p-8 text-center text-xs text-[#8f8f8f]">
                デイリーストアのアイテムを取得できませんでした。
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {data.daily.map((item) => {
                  const skin = resolveStoreSkin(catalog, item.itemId);
                  return (
                    <article
                      key={item.itemId}
                      className="vt-panel overflow-hidden group"
                    >
                      <div className="relative h-28 bg-gradient-to-b from-[#101010] to-[#0a0a0a] flex items-center justify-center px-3">
                        {skin?.icon ? (
                          <img
                            src={skin.icon}
                            alt={skin.name}
                            draggable={false}
                            className="max-h-24 max-w-full object-contain transition-transform duration-200 group-hover:scale-[1.04]"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded-[10px] border border-dashed border-[rgba(255,255,255,0.14)]" />
                        )}
                      </div>
                      <div className="px-4 pb-4 pt-3 space-y-1.5 vt-hairline-t">
                        <p className="text-xs text-[#ededed] truncate">
                          {itemLabel(skin?.name)}
                        </p>
                        <p className="font-num text-sm text-[#ededed]">
                          {formatPrice(item.price)}
                        </p>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {/* Featured bundle */}
          {data.bundle && (
            <section className="vt-panel overflow-hidden">
              <div className="px-5 py-3.5 flex items-center justify-between vt-hairline-b bg-[#0a0a0a]">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-[#8f8f8f]" />
                  <h2 className="text-sm font-medium text-[#ededed]">
                    注目のバンドル
                  </h2>
                </div>
                <span className="inline-flex items-center gap-1.5 font-num text-[11px] text-[#8f8f8f]">
                  <Clock className="w-3 h-3 text-[#5c5c5c]" />
                  {bundleTime}
                </span>
              </div>

              <div className="p-5 flex flex-col sm:flex-row sm:items-center gap-5">
                {bundleAsset?.icon && (
                  <img
                    src={bundleAsset.icon}
                    alt={bundleAsset.name}
                    draggable={false}
                    className="w-24 h-24 object-contain shrink-0 self-center"
                  />
                )}
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-base font-medium text-[#ededed] truncate">
                      {bundleAsset?.name ?? "バンドル"}
                    </h3>
                    {data.bundle.discountPercent > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-[rgba(255,255,255,0.14)] text-[#ededed] font-num">
                        -{data.bundle.discountPercent}%
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="font-num text-lg text-[#ededed]">
                      {formatPrice(data.bundle.totalPrice)}
                    </span>
                    <span className="font-num text-[11px] text-[#5c5c5c]">
                      {data.bundle.items.length} items
                    </span>
                  </div>

                  <div className="flex items-center gap-2 flex-wrap pt-1">
                    {data.bundle.items.slice(0, 10).map((item) => {
                      const skin = resolveStoreSkin(catalog, item.itemId);
                      return (
                        <div
                          key={item.itemId}
                          title={skin?.name ?? ""}
                          className="w-10 h-10 rounded-[8px] border border-[rgba(255,255,255,0.08)] bg-black flex items-center justify-center overflow-hidden"
                        >
                          {skin?.icon ? (
                            <img
                              src={skin.icon}
                              alt={skin.name}
                              draggable={false}
                              className="w-full h-full object-contain"
                            />
                          ) : (
                            <span className="text-[9px] text-[#5c5c5c]">?</span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Night market */}
          {data.nightMarket && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-medium text-[#ededed]">
                    ナイトマーケット
                  </h2>
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-[rgba(255,255,255,0.14)] text-[#8f8f8f]">
                    期間限定
                  </span>
                </div>
                <span className="inline-flex items-center gap-1.5 font-num text-[11px] text-[#8f8f8f]">
                  <Clock className="w-3 h-3 text-[#5c5c5c]" />
                  終了まで {nightTime}
                </span>
              </div>

              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {data.nightMarket.offers.map((offer) => {
                  const skin = resolveStoreSkin(catalog, offer.itemId);
                  return (
                    <article
                      key={offer.itemId}
                      className="vt-panel overflow-hidden group relative"
                    >
                      <span className="absolute top-3 left-3 z-10 text-[10px] font-num px-1.5 py-0.5 rounded bg-[#ededed] text-black">
                        -{Math.round(offer.discountPercent)}%
                      </span>
                      <div className="relative h-28 bg-gradient-to-b from-[#101010] to-[#0a0a0a] flex items-center justify-center px-3">
                        {skin?.icon ? (
                          <img
                            src={skin.icon}
                            alt={skin.name}
                            draggable={false}
                            className="max-h-24 max-w-full object-contain transition-transform duration-200 group-hover:scale-[1.04]"
                          />
                        ) : (
                          <div className="w-12 h-12 rounded-[10px] border border-dashed border-[rgba(255,255,255,0.14)]" />
                        )}
                      </div>
                      <div className="px-4 pb-4 pt-3 space-y-1.5 vt-hairline-t">
                        <p className="text-xs text-[#ededed] truncate">
                          {itemLabel(skin?.name)}
                        </p>
                        <div className="flex items-baseline gap-2">
                          <span className="font-num text-sm text-[#ededed]">
                            {formatPrice(offer.discountedPrice)}
                          </span>
                          <span className="font-num text-[11px] text-[#5c5c5c] line-through">
                            {Math.round(offer.originalPrice).toLocaleString("ja-JP")}
                          </span>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          <p className="text-[10px] text-[#5c5c5c] leading-relaxed">
            価格・ラインナップはRiotから取得した時点の情報です。表示は
            {defaultRegion.toUpperCase()} リージョンのアカウント設定に基づきます。
          </p>
        </>
      )}
    </div>
  );
}

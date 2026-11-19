import { useCallback, useEffect, useState } from "react";
import {
  Clock,
  Loader2,
  RefreshCw,
  ShoppingBag,
  Sparkles,
  Wallet,
} from "lucide-react";
import type { Region, StoreCatalog, StorefrontViewData } from "../types/valorant";
import {
  fetchStorefrontFromClient,
  parseStorefront,
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
  const [loading, setLoading] = useState(true);
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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchStorefrontFromClient(defaultRegion);

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
  }, [defaultRegion]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
            起動中のVALORANTクライアントから、デイリーストア・ナイトマーケット・バンドルを直接取得します。
          </p>
        </div>

        <div className="flex items-center gap-2.5 self-start sm:self-center shrink-0">
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
        </div>
      </div>

      {error && (
        <div className="vt-panel p-5 space-y-2">
          <p className="text-xs text-[#8f8f8f] leading-relaxed">{error}</p>
          <p className="text-[11px] text-[#5c5c5c] leading-relaxed">
            VALORANT にログインした状態で起動すると取得できます。ストアの反映にはゲーム内で一度ストアを開く必要がある場合があります。
          </p>
        </div>
      )}

      {loading && !data && (
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

      {data && (
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
            価格・ラインナップはRiotクライアントから取得した時点の情報です。表示は
            {defaultRegion.toUpperCase()} リージョンのアカウント設定に基づきます。
          </p>
        </>
      )}
    </div>
  );
}

import { invoke } from "@tauri-apps/api/core";
import type {
  CrosshairFetchResponse,
  FeaturedBundleItem,
  NightMarketOffer,
  Region,
  StoreItemRef,
  StorefrontFetchResponse,
  StorefrontViewData,
} from "../types/valorant";

const VP_CURRENCY_ID = "85ad13f7-3d1b-5128-9eb2-7cd8ee0b5741";
const RP_CURRENCY_ID = "85ca954a-41f2-ce94-9b45-8ca3dd39a00d";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function fetchCrosshairFromClient(): Promise<CrosshairFetchResponse> {
  if (!isTauriRuntime()) {
    return {
      ok: false,
      message: "クロスヘアの取得はデスクトップアプリ（.exe）でのみ利用可能です。",
      profileData: null,
      profileName: null,
      crosshairColor: null,
    };
  }
  return invoke<CrosshairFetchResponse>("fetch_crosshair_settings");
}

export async function fetchStorefrontFromClient(
  region: Region,
): Promise<StorefrontFetchResponse> {
  if (!isTauriRuntime()) {
    return {
      ok: false,
      message: "ストアの取得はデスクトップアプリ（.exe）でのみ利用可能です。",
      puuid: null,
      shard: null,
      region: null,
      storefront: null,
      wallet: null,
      fetchedAt: Date.now(),
    };
  }
  return invoke<StorefrontFetchResponse>("fetch_storefront", {
    regionFallback: region,
  });
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Picks the VP price from a storefront cost map, falling back to any currency. */
function costValue(cost: unknown, preferredId?: string): number {
  const record = asRecord(cost);
  if (!record) return 0;
  if (preferredId && typeof record[preferredId] === "number") {
    return record[preferredId] as number;
  }
  const first = Object.values(record).find((v): v is number => typeof v === "number");
  return first ?? 0;
}

function firstRewardItemId(offer: Json): string {
  const rewards = asArray(offer.Rewards);
  const first = asRecord(rewards[0]);
  if (!first) return "";
  const id = first.ItemID;
  return typeof id === "string" ? id : "";
}

export function parseStorefront(raw: unknown, walletRaw: unknown): StorefrontViewData | null {
  const root = asRecord(raw);
  if (!root) return null;

  const skinsPanel = asRecord(root.SkinsPanelLayout);
  const daily: StoreItemRef[] = asArray(skinsPanel?.SingleItemStoreOffers)
    .map((entry) => {
      const offer = asRecord(entry);
      if (!offer) return null;
      const itemId = firstRewardItemId(offer);
      if (!itemId) return null;
      return { itemId, price: costValue(offer.Cost, VP_CURRENCY_ID) };
    })
    .filter((v): v is StoreItemRef => Boolean(v));

  if (daily.length === 0) {
    // Older storefront payloads expose only the item IDs.
    for (const entry of asArray(skinsPanel?.SingleItemOffers)) {
      if (typeof entry === "string" && entry) daily.push({ itemId: entry, price: 0 });
    }
  }

  const dailyRemainingSeconds = toNumber(
    skinsPanel?.SingleItemOffersRemainingDurationInSeconds,
  );

  const bonusStore = asRecord(root.BonusStore);
  let nightMarket: StorefrontViewData["nightMarket"] = null;
  if (bonusStore) {
    const offers: NightMarketOffer[] = asArray(bonusStore.BonusStoreOffers)
      .map((entry) => {
        const wrapper = asRecord(entry);
        if (!wrapper) return null;
        const offer = asRecord(wrapper.Offer);
        if (!offer) return null;
        const itemId = firstRewardItemId(offer);
        if (!itemId) return null;
        const originalPrice = costValue(offer.Cost, VP_CURRENCY_ID);
        const discountedPrice =
          costValue(wrapper.DiscountCosts, VP_CURRENCY_ID) || originalPrice;
        return {
          itemId,
          price: originalPrice,
          originalPrice,
          discountedPrice,
          discountPercent: toNumber(wrapper.DiscountPercent),
        };
      })
      .filter((v): v is NightMarketOffer => Boolean(v));

    if (offers.length > 0) {
      nightMarket = {
        offers,
        remainingSeconds: toNumber(bonusStore.BonusStoreRemainingDurationInSeconds),
      };
    }
  }

  const featured = asRecord(root.FeaturedBundle);
  let bundle: StorefrontViewData["bundle"] = null;
  if (featured) {
    const bundleRecord = asRecord(featured.Bundle);
    if (bundleRecord) {
      const items: FeaturedBundleItem[] = asArray(bundleRecord.Items)
        .map((entry) => {
          const wrapper = asRecord(entry);
          const item = asRecord(wrapper?.Item);
          if (!wrapper || !item) return null;
          const itemId = typeof item.ItemID === "string" ? item.ItemID : "";
          if (!itemId) return null;
          const base = toNumber(wrapper.BasePrice);
          const discounted = toNumber(wrapper.DiscountedPrice) || base;
          return {
            itemId,
            price: base,
            discountedPrice: discounted,
            discountPercent: toNumber(wrapper.DiscountPercent),
          };
        })
        .filter((v): v is FeaturedBundleItem => Boolean(v));

      if (items.length > 0) {
        const totalBase = items.reduce((sum, i) => sum + i.price, 0);
        const totalPrice = items.reduce((sum, i) => sum + i.discountedPrice, 0);
        bundle = {
          dataAssetId:
            typeof bundleRecord.DataAssetID === "string" ? bundleRecord.DataAssetID : "",
          remainingSeconds: toNumber(featured.BundleRemainingDurationInSeconds),
          totalPrice,
          discountPercent:
            totalBase > 0
              ? Math.round(((totalBase - totalPrice) / totalBase) * 100)
              : 0,
          items,
        };
      }
    }
  }

  const wallet = asRecord(asRecord(walletRaw)?.Balances);
  const vp = wallet && typeof wallet[VP_CURRENCY_ID] === "number"
    ? (wallet[VP_CURRENCY_ID] as number)
    : null;
  const rp = wallet && typeof wallet[RP_CURRENCY_ID] === "number"
    ? (wallet[RP_CURRENCY_ID] as number)
    : null;

  return {
    daily,
    dailyRemainingSeconds,
    nightMarket,
    bundle,
    vp,
    rp,
  };
}

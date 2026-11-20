import type {
  StoreBundleAsset,
  StoreCatalog,
  StoreSkinAsset,
} from "../types/valorant";

const CACHE_KEY = "vt:store_catalog_v2";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const API_BASE = "https://valorant-api.com/v1";
const LANGUAGE = "ja-JP";

interface CachedCatalog {
  fetchedAt: number;
  catalog: StoreCatalog;
}

interface RawSkinLevel {
  uuid?: string;
  displayIcon?: string | null;
}

interface RawSkin {
  uuid?: string;
  displayName?: string;
  displayIcon?: string | null;
  levels?: RawSkinLevel[];
}

interface RawWeapon {
  uuid?: string;
  displayName?: string;
  displayIcon?: string | null;
  skins?: RawSkin[];
}

interface RawBundle {
  uuid?: string;
  displayName?: string;
  displayIcon?: string | null;
  displayIcon2?: string | null;
}

function emptyCatalog(): StoreCatalog {
  return { skinsByLevelId: {}, skinsById: {}, bundlesById: {} };
}

function readCache(): CachedCatalog | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedCatalog;
    if (!parsed?.catalog || typeof parsed.fetchedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(catalog: StoreCatalog) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ fetchedAt: Date.now(), catalog } satisfies CachedCatalog),
    );
  } catch {
    // Ignore quota errors; catalog still works for this session.
  }
}

async function fetchJson<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: T };
    return body.data ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function loadStoreCatalog(): Promise<StoreCatalog> {
  const cached = readCache();
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.catalog;
  }

  const [weapons, bundles] = await Promise.all([
    // `/weaponSkins` has been returning 404; `/weapons` also carries the skins
    // (and the weapon name) in one payload.
    fetchJson<RawWeapon[]>(`/weapons?language=${LANGUAGE}`),
    fetchJson<RawBundle[]>(`/bundles?language=${LANGUAGE}`),
  ]);

  if (!weapons || weapons.length === 0) {
    return cached?.catalog ?? emptyCatalog();
  }

  const catalog = emptyCatalog();

  for (const weapon of weapons) {
    for (const skin of weapon.skins ?? []) {
      if (!skin.uuid || !skin.displayName) continue;
      // The standard skin's own `displayicon.png` is a placeholder "X" image
      // (HTTP 200), so use the weapon render instead.
      const isStandard = /スタンダード|standard|default/i.test(skin.displayName);
      const asset: StoreSkinAsset = {
        uuid: skin.uuid,
        name: skin.displayName,
        icon: isStandard
          ? (weapon.displayIcon ?? "")
          : (skin.displayIcon ?? skin.levels?.[0]?.displayIcon ?? ""),
        weaponName: weapon.displayName ?? "",
      };
      catalog.skinsById[skin.uuid] = asset;
      for (const level of skin.levels ?? []) {
        if (level.uuid) catalog.skinsByLevelId[level.uuid] = asset;
      }
    }
  }

  for (const bundle of bundles ?? []) {
    if (!bundle.uuid || !bundle.displayName) continue;
    const asset: StoreBundleAsset = {
      uuid: bundle.uuid,
      name: bundle.displayName,
      icon: bundle.displayIcon2 ?? bundle.displayIcon ?? "",
    };
    catalog.bundlesById[bundle.uuid] = asset;
  }

  writeCache(catalog);
  return catalog;
}

export function resolveStoreSkin(
  catalog: StoreCatalog,
  itemId: string,
): StoreSkinAsset | undefined {
  return catalog.skinsByLevelId[itemId] ?? catalog.skinsById[itemId];
}

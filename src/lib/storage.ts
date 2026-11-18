import { load, type Store } from "@tauri-apps/plugin-store";
import type { AppSettings, Region, SavedPlayerEntry } from "../types/valorant";

const STORE_FILENAME = "valorant-tracker.json";

const KEYS = {
  SETTINGS: "vt_settings_v1",
  HISTORY: "vt_search_history_v1",
  FAVORITES: "vt_favorites_v1",
  CACHE_PREFIX: "vt_api_cache_v1:",
} as const;

export const BUILTIN_API_KEY = "HDEV-08526849-fe0e-48de-87d2-966f42b0d499";

export const DEFAULT_SETTINGS: AppSettings = {
  apiKey: BUILTIN_API_KEY,
  defaultRegion: "ap",
};

const VALID_REGIONS: Region[] = ["ap", "eu", "na", "kr", "latam", "br"];

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

let tauriStorePromise: Promise<Store | null> | null = null;

async function getTauriStore(): Promise<Store | null> {
  if (!isTauriRuntime()) return null;
  if (!tauriStorePromise) {
    tauriStorePromise = load(STORE_FILENAME, { autoSave: true, defaults: {} }).catch(() => null);
  }
  return tauriStorePromise;
}

function readLocalJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeLocalJson<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota errors
  }
}

async function persistBoth<T>(key: string, value: T): Promise<void> {
  writeLocalJson(key, value);
  const store = await getTauriStore();
  if (store) {
    try {
      await store.set(key, value);
      await store.save();
    } catch {
      // Fallback to localStorage already saved
    }
  }
}

export function sanitizeApiKey(raw: string): string {
  return raw.trim().replace(/^Bearer\s+/i, "").trim();
}

export function loadSettingsSync(): AppSettings {
  const saved = readLocalJson<Partial<AppSettings>>(KEYS.SETTINGS, {});
  const region = VALID_REGIONS.includes(saved.defaultRegion as Region)
    ? (saved.defaultRegion as Region)
    : DEFAULT_SETTINGS.defaultRegion;
  const savedKey = typeof saved.apiKey === "string" ? sanitizeApiKey(saved.apiKey) : "";
  return {
    apiKey: savedKey || BUILTIN_API_KEY,
    defaultRegion: region,
  };
}

export async function hydrateFromTauriStore(): Promise<{
  settings: AppSettings;
  history: SavedPlayerEntry[];
  favorites: SavedPlayerEntry[];
}> {
  const store = await getTauriStore();
  if (store) {
    try {
      const [s, h, f] = await Promise.all([
        store.get<AppSettings>(KEYS.SETTINGS),
        store.get<SavedPlayerEntry[]>(KEYS.HISTORY),
        store.get<SavedPlayerEntry[]>(KEYS.FAVORITES),
      ]);
      if (s) writeLocalJson(KEYS.SETTINGS, s);
      if (Array.isArray(h)) writeLocalJson(KEYS.HISTORY, h);
      if (Array.isArray(f)) writeLocalJson(KEYS.FAVORITES, f);
    } catch {
      // Ignore hydration errors and fall back to localStorage
    }
  }
  return {
    settings: loadSettingsSync(),
    history: loadSearchHistorySync(),
    favorites: loadFavoritesSync(),
  };
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const cleaned = sanitizeApiKey(settings.apiKey);
  const normalized: AppSettings = {
    apiKey: cleaned || BUILTIN_API_KEY,
    defaultRegion: VALID_REGIONS.includes(settings.defaultRegion) ? settings.defaultRegion : "ap",
  };
  await persistBoth(KEYS.SETTINGS, normalized);
  return normalized;
}

export function playerKey(name: string, tag: string, region?: Region): string {
  const base = `${name.trim().toLowerCase()}#${tag.trim().toLowerCase()}`;
  return region ? `${region}:${base}` : base;
}

export function loadSearchHistorySync(): SavedPlayerEntry[] {
  const items = readLocalJson<SavedPlayerEntry[]>(KEYS.HISTORY, []);
  return Array.isArray(items) ? items.slice(0, 10) : [];
}

export async function pushSearchHistory(entry: SavedPlayerEntry): Promise<SavedPlayerEntry[]> {
  const current = loadSearchHistorySync();
  const targetId = playerKey(entry.name, entry.tag);
  const next = [
    entry,
    ...current.filter((item) => playerKey(item.name, item.tag) !== targetId),
  ].slice(0, 10);
  await persistBoth(KEYS.HISTORY, next);
  return next;
}

export async function removeSearchHistoryItem(name: string, tag: string): Promise<SavedPlayerEntry[]> {
  const targetId = playerKey(name, tag);
  const next = loadSearchHistorySync().filter((item) => playerKey(item.name, item.tag) !== targetId);
  await persistBoth(KEYS.HISTORY, next);
  return next;
}

export async function clearSearchHistory(): Promise<SavedPlayerEntry[]> {
  await persistBoth(KEYS.HISTORY, []);
  return [];
}

export function loadFavoritesSync(): SavedPlayerEntry[] {
  const items = readLocalJson<SavedPlayerEntry[]>(KEYS.FAVORITES, []);
  return Array.isArray(items) ? items : [];
}

export async function toggleFavoritePlayer(entry: SavedPlayerEntry): Promise<SavedPlayerEntry[]> {
  const current = loadFavoritesSync();
  const targetId = playerKey(entry.name, entry.tag);
  const exists = current.some((item) => playerKey(item.name, item.tag) === targetId);
  const next = exists
    ? current.filter((item) => playerKey(item.name, item.tag) !== targetId)
    : [entry, ...current];
  await persistBoth(KEYS.FAVORITES, next);
  return next;
}

export async function updateStoredPlayerMeta(entry: SavedPlayerEntry): Promise<{
  history: SavedPlayerEntry[];
  favorites: SavedPlayerEntry[];
}> {
  const targetId = playerKey(entry.name, entry.tag);
  const history = loadSearchHistorySync().map((item) =>
    playerKey(item.name, item.tag) === targetId ? { ...item, ...entry } : item,
  );
  const favorites = loadFavoritesSync().map((item) =>
    playerKey(item.name, item.tag) === targetId ? { ...item, ...entry } : item,
  );
  await Promise.all([
    persistBoth(KEYS.HISTORY, history),
    persistBoth(KEYS.FAVORITES, favorites),
  ]);
  return { history, favorites };
}

/* =========================================================
 * 5-Minute API Response Cache (§8)
 * ========================================================= */

export const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEnvelope<T> {
  expiresAt: number;
  savedAt: number;
  data: T;
}

const memoryCache = new Map<string, CacheEnvelope<unknown>>();

export function getCachedData<T>(key: string): T | null {
  const fullKey = KEYS.CACHE_PREFIX + key;
  const now = Date.now();

  const mem = memoryCache.get(fullKey);
  if (mem) {
    if (mem.expiresAt > now) {
      return mem.data as T;
    }
    memoryCache.delete(fullKey);
  }

  try {
    const raw = window.localStorage.getItem(fullKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (parsed && parsed.expiresAt > now) {
      memoryCache.set(fullKey, parsed);
      return parsed.data;
    }
    window.localStorage.removeItem(fullKey);
  } catch {
    // Ignore parse error
  }
  return null;
}

export function setCachedData<T>(key: string, data: T, ttlMs: number = CACHE_TTL_MS): void {
  const fullKey = KEYS.CACHE_PREFIX + key;
  const now = Date.now();
  const envelope: CacheEnvelope<T> = {
    savedAt: now,
    expiresAt: now + ttlMs,
    data,
  };
  memoryCache.set(fullKey, envelope);
  try {
    const serialized = JSON.stringify(envelope);
    // Avoid blowing up localStorage with huge raw match arrays (> 450 KB); memoryCache still holds them for 5 min
    if (serialized.length < 450_000) {
      window.localStorage.setItem(fullKey, serialized);
    }
  } catch {
    // Ignore storage quota errors; in-memory cache remains active
  }
}

export function clearApiCache(): void {
  memoryCache.clear();
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(KEYS.CACHE_PREFIX)) {
        toRemove.push(k);
      }
    }
    for (const k of toRemove) {
      window.localStorage.removeItem(k);
    }
  } catch {
    // Ignore
  }
}

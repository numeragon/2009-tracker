import type {
  AgentAsset,
  MapAsset,
  TierAsset,
  ValorantAssetsCatalog,
} from "../types/valorant";
import { getCachedData, setCachedData } from "./storage";

const ASSETS_CACHE_KEY = "valorant_api_assets_ja_v4";
const ASSETS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const EMPTY_CATALOG: ValorantAssetsCatalog = {
  agentsById: {},
  agentsByKey: {},
  mapsById: {},
  mapsByKey: {},
  tiersById: {},
  weaponsById: {},
};

let inflightAssetsPromise: Promise<ValorantAssetsCatalog> | null = null;

function normKey(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

interface ValorantApiListResponse<T> {
  status: number;
  data: T[];
}

export async function loadValorantAssets(): Promise<ValorantAssetsCatalog> {
  const cached = getCachedData<ValorantAssetsCatalog>(ASSETS_CACHE_KEY);
  if (cached && Object.keys(cached.agentsById).length > 0) {
    return cached;
  }

  if (inflightAssetsPromise) {
    return inflightAssetsPromise;
  }

  inflightAssetsPromise = (async () => {
    try {
      const [agentsJaRes, agentsEnRes, mapsJaRes, mapsEnRes, tiersJaRes, weaponsJaRes] =
        await Promise.all([
          fetch("https://valorant-api.com/v1/agents?isPlayableCharacter=true&language=ja-JP").then(
            (r) => r.json() as Promise<ValorantApiListResponse<{
              uuid: string;
              displayName: string;
              displayIcon: string;
              bustPortrait?: string;
            }>>,
          ),
          fetch("https://valorant-api.com/v1/agents?isPlayableCharacter=true").then(
            (r) => r.json() as Promise<ValorantApiListResponse<{
              uuid: string;
              displayName: string;
            }>>,
          ),
          fetch("https://valorant-api.com/v1/maps?language=ja-JP").then(
            (r) => r.json() as Promise<ValorantApiListResponse<{
              uuid: string;
              displayName: string;
              mapUrl?: string;
              listViewIcon?: string;
              splash?: string;
            }>>,
          ),
          fetch("https://valorant-api.com/v1/maps").then(
            (r) => r.json() as Promise<ValorantApiListResponse<{
              uuid: string;
              displayName: string;
            }>>,
          ),
          fetch("https://valorant-api.com/v1/competitivetiers?language=ja-JP").then(
            (r) => r.json() as Promise<ValorantApiListResponse<{
              uuid: string;
              tiers: Array<{
                tier: number;
                tierName: string;
                smallIcon?: string;
                largeIcon?: string;
              }>;
            }>>,
          ),
          fetch("https://valorant-api.com/v1/weapons?language=ja-JP")
            .then(
              (r) => r.json() as Promise<ValorantApiListResponse<{
                uuid: string;
                displayName: string;
                displayIcon?: string;
                category?: string;
                shopData?: { cost?: number };
              }>>,
            )
            .catch(() => ({ status: 200, data: [] })),
        ]);

      const catalog: ValorantAssetsCatalog = {
        agentsById: {},
        agentsByKey: {},
        mapsById: {},
        mapsByKey: {},
        tiersById: {},
        weaponsById: {},
      };

      for (const a of agentsJaRes.data ?? []) {
        const id = normKey(a.uuid);
        const asset: AgentAsset = {
          uuid: a.uuid,
          displayName: a.displayName,
          displayIcon: a.displayIcon,
          bustPortrait: a.bustPortrait,
        };
        catalog.agentsById[id] = asset;
        catalog.agentsByKey[normKey(a.displayName)] = asset;
      }

      for (const aEn of agentsEnRes.data ?? []) {
        const asset = catalog.agentsById[normKey(aEn.uuid)];
        if (asset) {
          catalog.agentsByKey[normKey(aEn.displayName)] = asset;
        }
      }

      for (const m of mapsJaRes.data ?? []) {
        const id = normKey(m.uuid);
        const asset: MapAsset = {
          uuid: m.uuid,
          displayName: m.displayName,
          mapUrl: m.mapUrl,
          listViewIcon: m.listViewIcon,
          splash: m.splash,
        };
        catalog.mapsById[id] = asset;
        catalog.mapsByKey[normKey(m.displayName)] = asset;
        if (m.mapUrl) {
          catalog.mapsByKey[normKey(m.mapUrl)] = asset;
        }
      }

      for (const mEn of mapsEnRes.data ?? []) {
        const asset = catalog.mapsById[normKey(mEn.uuid)];
        if (asset) {
          catalog.mapsByKey[normKey(mEn.displayName)] = asset;
        }
      }

      const tierTables = tiersJaRes.data ?? [];
      const latestTable = tierTables[tierTables.length - 1];
      if (latestTable?.tiers) {
        for (const t of latestTable.tiers) {
          const tierAsset: TierAsset = {
            tier: t.tier,
            tierName: t.tierName,
            smallIcon: t.smallIcon ?? undefined,
            largeIcon: t.largeIcon ?? undefined,
          };
          catalog.tiersById[t.tier] = tierAsset;
        }
      }

      for (const [index, w] of (weaponsJaRes.data ?? []).entries()) {
        catalog.weaponsById[normKey(w.uuid)] = {
          uuid: w.uuid,
          displayName: w.displayName,
          displayIcon: w.displayIcon,
          order: index,
          category: w.category,
          cost: w.shopData?.cost,
        };
      }

      setCachedData(ASSETS_CACHE_KEY, catalog, ASSETS_TTL_MS);
      return catalog;
    } catch {
      return EMPTY_CATALOG;
    } finally {
      inflightAssetsPromise = null;
    }
  })();

  return inflightAssetsPromise;
}

export function resolveAgentAsset(
  catalog: ValorantAssetsCatalog,
  agentId?: string | null,
  agentName?: string | null,
): AgentAsset | undefined {
  if (agentId) {
    const byId = catalog.agentsById[normKey(agentId)];
    if (byId) return byId;
  }
  if (agentName) {
    const byName = catalog.agentsByKey[normKey(agentName)];
    if (byName) return byName;
  }
  return undefined;
}

export function resolveMapAsset(
  catalog: ValorantAssetsCatalog,
  mapId?: string | null,
  mapName?: string | null,
): MapAsset | undefined {
  if (mapId) {
    const byId = catalog.mapsById[normKey(mapId)];
    if (byId) return byId;
  }
  if (mapName) {
    const byName = catalog.mapsByKey[normKey(mapName)];
    if (byName) return byName;
  }
  return undefined;
}

export function resolveTierAsset(
  catalog: ValorantAssetsCatalog,
  tierId?: number | null,
): TierAsset | undefined {
  if (tierId === null || tierId === undefined) return undefined;
  return catalog.tiersById[tierId];
}

function isZeroCardId(id: string): boolean {
  const compact = id.replace(/-/g, "");
  return compact.length === 0 || /^0+$/.test(compact);
}

export function buildPlayerCardUrls(
  card: string | { id?: string; small?: string; large?: string; wide?: string } | undefined,
): {
  cardId: string;
  small: string;
  wide: string;
  large: string;
} {
  if (card && typeof card === "object") {
    const id = card.id ?? "";
    const valid = id && !isZeroCardId(id);
    return {
      cardId: valid ? id : "",
      small: card.small ?? (valid ? `https://media.valorant-api.com/playercards/${id}/smallart.png` : ""),
      wide: card.wide ?? (valid ? `https://media.valorant-api.com/playercards/${id}/wideart.png` : ""),
      large: card.large ?? (valid ? `https://media.valorant-api.com/playercards/${id}/largeart.png` : ""),
    };
  }
  const id = (card ?? "").trim();
  if (!id || isZeroCardId(id)) {
    return { cardId: "", small: "", wide: "", large: "" };
  }
  return {
    cardId: id,
    small: `https://media.valorant-api.com/playercards/${id}/smallart.png`,
    wide: `https://media.valorant-api.com/playercards/${id}/wideart.png`,
    large: `https://media.valorant-api.com/playercards/${id}/largeart.png`,
  };
}

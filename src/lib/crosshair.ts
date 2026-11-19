/**
 * VALORANT crosshair profile parsing / share-code generation.
 *
 * Two sources are supported:
 *  - The game's own serialized profile JSON (`SavedCrosshairProfileData`)
 *  - Imported share codes (`0;P;c;5;...`)
 */

export interface CrosshairLines {
  show: boolean;
  opacity: number;
  length: number;
  vertical: number;
  linked: boolean;
  thickness: number;
  offset: number;
  movementError: boolean;
  movementMultiplier: number;
  firingError: boolean;
  firingMultiplier: number;
}

export interface CrosshairVisual {
  color: string;
  outline: {
    show: boolean;
    thickness: number;
    opacity: number;
    color: string;
  };
  centerDot: {
    show: boolean;
    size: number;
    opacity: number;
  };
  inner: CrosshairLines;
  outer: CrosshairLines;
}

export interface CrosshairSniperDot {
  show: boolean;
  size: number;
  opacity: number;
  color: string;
}

export interface CrosshairConfig {
  name: string;
  advanced: boolean;
  adsSameAsPrimary: boolean;
  primary: CrosshairVisual;
  ads: CrosshairVisual | null;
  sniper: CrosshairSniperDot | null;
}

export interface SavedCrosshair {
  id: string;
  name: string;
  code: string;
  config: CrosshairConfig;
  source: "game" | "import";
  createdAt: number;
}

/** In-game preset color order. */
export const CROSSHAIR_PRESET_COLORS: Array<{ hex: string; label: string }> = [
  { hex: "#FFFFFF", label: "白" },
  { hex: "#00FF00", label: "緑" },
  { hex: "#7FFF00", label: "黄緑" },
  { hex: "#DFFF00", label: "緑黄" },
  { hex: "#FFFF00", label: "黄" },
  { hex: "#00FFFF", label: "シアン" },
  { hex: "#FF00FF", label: "ピンク" },
  { hex: "#FF0000", label: "赤" },
];

const SAVED_KEY = "vt:saved_crosshairs_v1";
const MAX_SAVED = 40;

export function createDefaultLines(): CrosshairLines {
  return {
    show: true,
    opacity: 1,
    length: 6,
    vertical: 6,
    linked: true,
    thickness: 2,
    offset: 3,
    movementError: true,
    movementMultiplier: 1,
    firingError: true,
    firingMultiplier: 1,
  };
}

export function createDefaultVisual(): CrosshairVisual {
  return {
    color: "#FFFFFF",
    outline: { show: true, thickness: 1, opacity: 0.5, color: "#000000" },
    centerDot: { show: false, size: 2, opacity: 1 },
    inner: createDefaultLines(),
    outer: {
      ...createDefaultLines(),
      show: false,
      opacity: 0.35,
      length: 2,
      vertical: 2,
      offset: 10,
    },
  };
}

export function createDefaultConfig(name = "クロスヘア"): CrosshairConfig {
  return {
    name,
    advanced: false,
    adsSameAsPrimary: true,
    primary: createDefaultVisual(),
    ads: null,
    sniper: { show: false, size: 1, opacity: 1, color: "#FFFFFF" },
  };
}

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function pick(record: Json | null, ...keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function num(record: Json | null, keys: string[], fallback: number): number {
  const value = pick(record, ...keys);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bool(record: Json | null, keys: string[], fallback: boolean): boolean {
  const value = pick(record, ...keys);
  return typeof value === "boolean" ? value : fallback;
}

function str(record: Json | null, keys: string[], fallback: string): string {
  const value = pick(record, ...keys);
  return typeof value === "string" ? value : fallback;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseColorRecord(record: Json | null, fallback: string): string {
  if (!record) return fallback;
  const r = num(record, ["R", "r"], NaN);
  const g = num(record, ["G", "g"], NaN);
  const b = num(record, ["B", "b"], NaN);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return fallback;
  return rgbToHex(clampByte(r), clampByte(g), clampByte(b));
}

/** Parses the legacy "(R=0,G=255,B=0,A=255)" string. */
export function parseColorString(raw: string | null | undefined, fallback = "#FFFFFF"): string {
  if (!raw) return fallback;
  const m = raw.match(
    /R\s*=\s*(\d+)\s*,\s*G\s*=\s*(\d+)\s*,\s*B\s*=\s*(\d+)/i,
  );
  if (!m) return fallback;
  return rgbToHex(Number(m[1]), Number(m[2]), Number(m[3]));
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number) => clampByte(v).toString(16).padStart(2, "0").toUpperCase();
  return `#${to(r)}${to(g)}${to(b)}`;
}

export function hexToRgb(hex: string): Rgba {
  const clean = hex.replace("#", "");
  const full = clean.length === 3
    ? clean.split("").map((c) => c + c).join("")
    : clean.slice(0, 6).padEnd(6, "0");
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const a = clean.length >= 8 ? parseInt(clean.slice(6, 8), 16) : 255;
  return {
    r: Number.isNaN(r) ? 0 : r,
    g: Number.isNaN(g) ? 0 : g,
    b: Number.isNaN(b) ? 0 : b,
    a: Number.isNaN(a) ? 255 : a,
  };
}

function parseLines(record: Json | null): CrosshairLines {
  const defaults = createDefaultLines();
  if (!record) return defaults;
  const allowVertical = bool(record, ["bAllowVertScaling", "allowVertScaling"], false);
  const length = num(record, ["LineLength", "lineLength"], defaults.length);
  const vertical = num(record, ["LineLengthVertical", "lineLengthVertical"], length);
  return {
    show: bool(record, ["bShowLines", "showLines"], defaults.show),
    opacity: num(record, ["Opacity", "opacity"], defaults.opacity),
    length,
    vertical,
    linked: !allowVertical,
    thickness: num(record, ["LineThickness", "lineThickness"], defaults.thickness),
    offset: num(record, ["LineOffset", "lineOffset"], defaults.offset),
    movementError: bool(
      record,
      ["bShowMovementError", "showMovementError"],
      defaults.movementError,
    ),
    movementMultiplier: num(
      record,
      ["movementErrorScale", "MovementErrorScale"],
      defaults.movementMultiplier,
    ),
    firingError: bool(
      record,
      ["bShowShootingError", "showShootingError"],
      defaults.firingError,
    ),
    firingMultiplier: num(
      record,
      ["firingErrorScale", "FiringErrorScale"],
      defaults.firingMultiplier,
    ),
  };
}

function parseVisual(record: Json | null): CrosshairVisual {
  const defaults = createDefaultVisual();
  if (!record) return defaults;
  const outlineColor = pick(record, "OutlineColor", "outlineColor");
  // The game keeps the preset pick in `color` and the real value of a custom
  // color in `colorCustom`, gated by `bUseCustomColor`.
  const useCustom = bool(record, ["bUseCustomColor", "useCustomColor"], false);
  const colorRecord = useCustom
    ? pick(record, "ColorCustom", "colorCustom") ?? pick(record, "Color", "color")
    : pick(record, "Color", "color");
  return {
    color: parseColorRecord(asRecord(colorRecord), defaults.color),
    outline: {
      show: bool(record, ["bHasOutline", "hasOutline"], defaults.outline.show),
      thickness: num(
        record,
        ["OutlineThickness", "outlineThickness"],
        defaults.outline.thickness,
      ),
      opacity: num(record, ["OutlineOpacity", "outlineOpacity"], defaults.outline.opacity),
      color: parseColorRecord(asRecord(outlineColor), defaults.outline.color),
    },
    centerDot: {
      show: bool(
        record,
        ["bDisplayCenterDot", "displayCenterDot"],
        defaults.centerDot.show,
      ),
      size: num(record, ["CenterDotSize", "centerDotSize"], defaults.centerDot.size),
      opacity: num(
        record,
        ["CenterDotOpacity", "centerDotOpacity"],
        defaults.centerDot.opacity,
      ),
    },
    inner: parseLines(asRecord(pick(record, "InnerLines", "innerLines"))),
    outer: parseLines(asRecord(pick(record, "OuterLines", "outerLines"))),
  };
}

function parseSniper(record: Json | null): CrosshairSniperDot | null {
  if (!record) return null;
  const useCustom = bool(
    record,
    ["bUseCustomCenterDotColor", "useCustomCenterDotColor"],
    false,
  );
  const colorRecord = useCustom
    ? pick(record, "CenterDotColorCustom", "centerDotColorCustom") ??
      pick(record, "CenterDotColor", "centerDotColor")
    : pick(record, "CenterDotColor", "centerDotColor");
  const color = parseColorRecord(asRecord(colorRecord), "#FFFFFF");
  return {
    show: bool(record, ["bDisplayCenterDot", "displayCenterDot"], true),
    size: num(record, ["CenterDotSize", "centerDotSize"], 1),
    opacity: num(record, ["CenterDotOpacity", "centerDotOpacity"], 1),
    color,
  };
}

/**
 * Parses the game's `SavedCrosshairProfileData` JSON (PascalCase from the
 * Unreal serializer, but camelCase is accepted too).
 */
export function parseGameProfile(
  raw: string | null | undefined,
  fallbackName = "クロスヘア",
): CrosshairConfig | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Some client versions double-encode the payload.
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }

  const root = asRecord(Array.isArray(parsed) ? parsed[0] : parsed);
  if (!root) return null;

  let profiles = pick(root, "Profiles", "profiles");
  let list: unknown[] = Array.isArray(profiles) ? profiles : [];
  if (list.length === 0 && pick(root, "Primary", "primary")) {
    list = [root];
  }
  if (list.length === 0) return null;

  const currentIndex = num(root, ["CurrentProfile", "currentProfile"], 0);
  const profile =
    asRecord(list[currentIndex]) ?? asRecord(list[0]) ?? null;
  if (!profile) return null;

  // Most client dumps nest the actual values under `Primary`.
  const primaryRecord =
    asRecord(pick(profile, "Primary", "primary")) ?? profile;
  const primary = parseVisual(primaryRecord);
  const adsRecord =
    asRecord(pick(profile, "aDS", "ads", "ADS")) ??
    asRecord(pick(primaryRecord, "aDS", "ads", "ADS"));
  const adsSame = bool(
    profile,
    ["bUsePrimaryCrosshairForADS", "usePrimaryCrosshairForADS"],
    true,
  );

  const config: CrosshairConfig = {
    name: str(profile, ["ProfileName", "profileName"], fallbackName) || fallbackName,
    advanced: bool(profile, ["bUseAdvancedOptions", "useAdvancedOptions"], false),
    adsSameAsPrimary: adsSame,
    primary,
    ads: !adsSame && adsRecord ? parseVisual(adsRecord) : null,
    sniper: parseSniper(asRecord(pick(profile, "Sniper", "sniper"))),
  };

  return config;
}

/* -------------------------- Share code generation -------------------------- */

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

function presetIndex(hex: string): number {
  const upper = hex.toUpperCase();
  return CROSSHAIR_PRESET_COLORS.findIndex((c) => c.hex === upper);
}

function appendLines(parts: string[], prefix: "0" | "1", lines: CrosshairLines) {
  // Key order follows the game's own export format.
  parts.push(`${prefix}b`, lines.show ? "1" : "0");
  parts.push(`${prefix}t`, formatNumber(lines.thickness));
  parts.push(`${prefix}l`, formatNumber(lines.length));
  if (!lines.linked) {
    // `v` (vertical length) and `g` (separate vertical scaling) only appear
    // when the vertical length differs from the horizontal one.
    parts.push(`${prefix}v`, formatNumber(lines.vertical));
    parts.push(`${prefix}g`, "1");
  }
  parts.push(`${prefix}o`, formatNumber(lines.offset));
  parts.push(`${prefix}a`, formatNumber(lines.opacity));
  parts.push(`${prefix}m`, lines.movementError ? "1" : "0");
  parts.push(`${prefix}f`, lines.firingError ? "1" : "0");
  if (lines.movementMultiplier !== 1) {
    parts.push(`${prefix}s`, formatNumber(lines.movementMultiplier));
  }
  if (lines.firingMultiplier !== 1) {
    parts.push(`${prefix}e`, formatNumber(lines.firingMultiplier));
  }
}

function appendVisual(parts: string[], visual: CrosshairVisual) {
  const idx = presetIndex(visual.color);
  if (idx >= 0) {
    parts.push("c", String(idx));
  } else {
    // Custom colors are `c;8` + `u;RRGGBBAA` + `b;1` (hex-color flag), exactly
    // as the game exports them.
    const { r, g, b } = hexToRgb(visual.color);
    parts.push("c", "8", "u", `${rgbToHex(r, g, b).replace("#", "")}FF`, "b", "1");
  }

  parts.push("h", visual.outline.show ? "1" : "0");
  parts.push("o", formatNumber(visual.outline.opacity));
  parts.push("t", formatNumber(visual.outline.thickness));

  parts.push("d", visual.centerDot.show ? "1" : "0");
  parts.push("a", formatNumber(visual.centerDot.opacity));
  parts.push("z", formatNumber(visual.centerDot.size));

  appendLines(parts, "0", visual.inner);
  appendLines(parts, "1", visual.outer);
}

export function generateCrosshairCode(config: CrosshairConfig): string {
  const parts: string[] = ["0"];

  if (config.advanced) {
    // Game export puts the ADS "use primary" flag before the advanced flag.
    if (!config.adsSameAsPrimary) parts.push("p", "0");
    parts.push("s", "1");
  }

  parts.push("P");
  appendVisual(parts, config.primary);

  if (config.advanced && !config.adsSameAsPrimary) {
    parts.push("A");
    appendVisual(parts, config.ads ?? config.primary);
  }

  if (config.advanced && config.sniper) {
    parts.push("S");
    parts.push("d", config.sniper.show ? "1" : "0");
    const idx = presetIndex(config.sniper.color);
    parts.push("c", idx >= 0 ? String(idx) : "8");
    if (idx < 0) {
      const { r, g, b } = hexToRgb(config.sniper.color);
      parts.push("b", "1", "t", `${rgbToHex(r, g, b).replace("#", "")}FF`);
    }
    parts.push("s", formatNumber(config.sniper.size));
    parts.push("o", formatNumber(config.sniper.opacity));
  }

  return parts.join(";");
}

/* ----------------------------- Share code parse ---------------------------- */

function applyLineKey(target: CrosshairLines, key: string, raw: string) {
  const value = raw.trim();
  const asBool = () => value === "1" || value.toLowerCase() === "true";
  const asNum = () => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };
  switch (key) {
    case "b":
      target.show = asBool();
      break;
    case "a":
      target.opacity = asNum();
      break;
    case "l":
      target.length = asNum();
      break;
    case "v":
      target.vertical = asNum();
      break;
    case "g":
      target.linked = !asBool();
      break;
    case "t":
      target.thickness = asNum();
      break;
    case "o":
      target.offset = asNum();
      break;
    case "m":
      target.movementError = asBool();
      break;
    case "s":
      target.movementMultiplier = asNum();
      break;
    case "f":
      target.firingError = asBool();
      break;
    case "e":
      target.firingMultiplier = asNum();
      break;
    default:
      break;
  }
}

function applyVisualPair(visual: CrosshairVisual, key: string, value: string) {
  const asBool = () => value === "1" || value.toLowerCase() === "true";
  const asNum = () => {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  };

  if ((key.startsWith("0") || key.startsWith("1")) && key.length === 2) {
    const target = key.startsWith("0") ? visual.inner : visual.outer;
    applyLineKey(target, key[1], value);
    return;
  }

  switch (key) {
    case "c": {
      const idx = Number(value);
      if (Number.isInteger(idx) && idx >= 0 && idx < CROSSHAIR_PRESET_COLORS.length) {
        visual.color = CROSSHAIR_PRESET_COLORS[idx].hex;
      }
      break;
    }
    case "u": {
      const clean = value.replace(/[^0-9a-fA-F]/g, "");
      if (clean.length >= 6) visual.color = `#${clean.slice(0, 6).toUpperCase()}`;
      break;
    }
    case "h":
      visual.outline.show = asBool();
      break;
    case "t":
      visual.outline.thickness = asNum();
      break;
    case "o":
      visual.outline.opacity = asNum();
      break;
    case "d":
      visual.centerDot.show = asBool();
      break;
    case "z":
      visual.centerDot.size = asNum();
      break;
    case "a":
      visual.centerDot.opacity = asNum();
      break;
    default:
      break;
  }
}

function parsePairs(body: string, onPair: (key: string, value: string) => void) {
  const tokens = body.split(";").map((t) => t.trim()).filter(Boolean);
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    onPair(tokens[i], tokens[i + 1]);
  }
}

/**
 * Parses a VALORANT share code. Unknown tokens are ignored, so both full and
 * partial codes are accepted.
 */
export function parseCrosshairCode(code: string): CrosshairConfig | null {
  const cleaned = code.trim().replace(/\s+/g, "");
  if (!cleaned.startsWith("0;") && cleaned !== "0") return null;
  if (cleaned === "0") return createDefaultConfig("デフォルト");

  const segments = cleaned.split(/(P|A|S|NAME);/);
  const config = createDefaultConfig();
  const primary = createDefaultVisual();

  let sawPrimarySection = false;

  // Prefix before the first section marker (contains version + advanced flags).
  const prefixBody = segments[0] ?? "";
  const hasMarker = segments.length > 1;
  const unprefixed = prefixBody.replace(/^0;?/, "");

  // `p;0` means the ADS crosshair has its own settings (does not copy the
  // primary), even when the `A` section is omitted.
  if (unprefixed.includes("p;0")) {
    config.adsSameAsPrimary = false;
    config.advanced = true;
  }

  const sectionBodies: Record<string, string> = {};
  for (let i = 1; i < segments.length; i += 2) {
    const key = segments[i];
    const body = segments[i + 1] ?? "";
    sectionBodies[key] = body;
  }

  if (!hasMarker) {
    // Legacy / bare code: everything after the version belongs to primary.
    parsePairs(unprefixed, (k, v) => applyVisualPair(primary, k, v));
    sawPrimarySection = true;
  } else {
    // Some exports place color/advanced flags before the first `P` marker.
    parsePairs(unprefixed, (k, v) => applyVisualPair(primary, k, v));

    if (sectionBodies.P !== undefined) {
      parsePairs(sectionBodies.P, (k, v) => applyVisualPair(primary, k, v));
      sawPrimarySection = true;
    } else {
      // No explicit P marker: tokens between the version and the first marker.
      const firstMarkerIndex = cleaned.indexOf(";A;");
      const rawPrimary =
        firstMarkerIndex >= 0
          ? cleaned.slice(2, firstMarkerIndex)
          : segments.length > 1
            ? segments[0].replace(/^0;?/, "")
            : "";
      parsePairs(rawPrimary, (k, v) => applyVisualPair(primary, k, v));
      sawPrimarySection = true;
    }

    if (sectionBodies.A !== undefined) {
      const ads = createDefaultVisual();
      parsePairs(sectionBodies.A, (k, v) => applyVisualPair(ads, k, v));
      config.ads = ads;
      config.adsSameAsPrimary = false;
    }

    if (sectionBodies.S !== undefined) {
      const sniper = { show: true, size: 1, opacity: 1, color: "#FFFFFF" };
      parsePairs(sectionBodies.S, (k, v) => {
        if (k === "d") sniper.show = v === "1";
        else if (k === "c") {
          const idx = Number(v);
          if (idx >= 0 && idx < CROSSHAIR_PRESET_COLORS.length) {
            sniper.color = CROSSHAIR_PRESET_COLORS[idx].hex;
          }
        } else if (k === "u" || k === "t") {
          const clean = v.replace(/[^0-9a-fA-F]/g, "");
          if (clean.length >= 6) sniper.color = `#${clean.slice(0, 6).toUpperCase()}`;
        } else if (k === "s") sniper.size = Number(v) || 0;
        else if (k === "o") sniper.opacity = Number(v) || 0;
      });
      config.sniper = sniper;
    }

    if (sectionBodies.NAME !== undefined) {
      config.name = sectionBodies.NAME.replace(/^"|"$/g, "").trim() || config.name;
    }
  }

  if (!sawPrimarySection) return null;

  config.primary = primary;
  if (sectionBodies.S !== undefined || sectionBodies.A !== undefined || unprefixed.includes("s;1")) {
    config.advanced = true;
  }

  return config;
}

/* ------------------------------ Local storage ----------------------------- */

export function loadSavedCrosshairs(): SavedCrosshair[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Regenerate codes from the stored config so older entries pick up
    // format fixes without losing the saved settings.
    return (parsed as SavedCrosshair[]).map((item) =>
      item?.config
        ? { ...item, code: generateCrosshairCode(item.config) }
        : item,
    );
  } catch {
    return [];
  }
}

function persistSavedCrosshairs(list: SavedCrosshair[]) {
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(0, MAX_SAVED)));
  } catch {
    // Ignore quota errors
  }
}

export function saveCrosshairEntry(
  config: CrosshairConfig,
  source: SavedCrosshair["source"],
  name?: string,
): SavedCrosshair[] {
  const finalName = (name ?? config.name ?? "").trim() || "クロスヘア";
  const nextConfig = { ...config, name: finalName };
  const entry: SavedCrosshair = {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `ch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: finalName,
    code: generateCrosshairCode(nextConfig),
    config: nextConfig,
    source,
    createdAt: Date.now(),
  };
  const current = loadSavedCrosshairs().filter(
    (item) => item.code !== entry.code || item.name !== entry.name,
  );
  const next = [entry, ...current];
  persistSavedCrosshairs(next);
  return next;
}

export function deleteCrosshairEntry(id: string): SavedCrosshair[] {
  const next = loadSavedCrosshairs().filter((item) => item.id !== id);
  persistSavedCrosshairs(next);
  return next;
}

export function renameCrosshairEntry(id: string, name: string): SavedCrosshair[] {
  const next = loadSavedCrosshairs().map((item) =>
    item.id === id
      ? {
          ...item,
          name: name.trim() || item.name,
          config: { ...item.config, name: name.trim() || item.name },
        }
      : item,
  );
  persistSavedCrosshairs(next);
  return next;
}

export interface OverlaySettings {
  /** Show the overlay automatically when agent select starts. */
  autoShow: boolean;
}

const STORAGE_KEY = "vt:overlay_settings_v1";

const DEFAULTS: OverlaySettings = {
  autoShow: true,
};

export function loadOverlaySettings(): OverlaySettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<OverlaySettings> | null;
    return {
      autoShow:
        typeof parsed?.autoShow === "boolean"
          ? parsed.autoShow
          : DEFAULTS.autoShow,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveOverlaySettings(settings: OverlaySettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors.
  }
}

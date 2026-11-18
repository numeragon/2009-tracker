import { openUrl } from "@tauri-apps/plugin-opener";

export async function openExternalUrl(url: string): Promise<void> {
  try {
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      await openUrl(url);
      return;
    }
  } catch {
    // Fallback below
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

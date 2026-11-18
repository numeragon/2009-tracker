import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function getCurrentAppVersion(): Promise<string> {
  if (!isTauriRuntime()) return "0.1.0";
  try {
    return await getVersion();
  } catch {
    return "0.1.0";
  }
}

export interface UpdateProgressState {
  phase: "idle" | "checking" | "downloading" | "installing" | "up-to-date" | "error";
  version?: string;
  percent?: number;
  message?: string;
}

export async function checkAndApplyUpdate(
  onProgress?: (state: UpdateProgressState) => void,
): Promise<boolean> {
  if (!isTauriRuntime()) {
    onProgress?.({
      phase: "error",
      message: "自動アップデートはデスクトップアプリ（.exe）でのみ動作します。",
    });
    return false;
  }

  onProgress?.({ phase: "checking" });

  try {
    const update = await check();
    if (!update) {
      onProgress?.({
        phase: "up-to-date",
        message: "最新バージョンを使用中です。",
      });
      return false;
    }

    let downloadedBytes = 0;
    let totalBytes = 0;

    onProgress?.({
      phase: "downloading",
      version: update.version,
      percent: 0,
    });

    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        totalBytes = event.data.contentLength ?? 0;
        downloadedBytes = 0;
        onProgress?.({
          phase: "downloading",
          version: update.version,
          percent: 0,
        });
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        const pct =
          totalBytes > 0
            ? Math.min(99, Math.round((downloadedBytes / totalBytes) * 100))
            : undefined;
        onProgress?.({
          phase: "downloading",
          version: update.version,
          percent: pct,
        });
      } else if (event.event === "Finished") {
        onProgress?.({
          phase: "installing",
          version: update.version,
          percent: 100,
        });
      }
    });

    await relaunch();
    return true;
  } catch (err) {
    onProgress?.({
      phase: "error",
      message: err instanceof Error ? err.message : "アップデート確認に失敗しました。",
    });
    return false;
  }
}

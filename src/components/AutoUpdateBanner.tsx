import { useEffect, useState } from "react";
import { DownloadCloud } from "lucide-react";
import { checkAndApplyUpdate, type UpdateProgressState } from "../lib/updater";

export function AutoUpdateBanner() {
  const [state, setState] = useState<UpdateProgressState>({ phase: "idle" });

  useEffect(() => {
    // Check 2.5 seconds after startup, then every 30 minutes
    const initialTimer = window.setTimeout(() => {
      void checkAndApplyUpdate((s) => {
        if (s.phase === "downloading" || s.phase === "installing") {
          setState(s);
        }
      });
    }, 2500);

    const intervalTimer = window.setInterval(() => {
      void checkAndApplyUpdate((s) => {
        if (s.phase === "downloading" || s.phase === "installing") {
          setState(s);
        }
      });
    }, 30 * 60 * 1000);

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(intervalTimer);
    };
  }, []);

  if (state.phase !== "downloading" && state.phase !== "installing") {
    return null;
  }

  return (
    <div className="px-6 py-2 vt-hairline-b bg-[#0a0a0a]/90 backdrop-blur-md flex items-center justify-between gap-4 text-xs vt-animate-in shrink-0">
      <div className="flex items-center gap-2.5 text-[#ededed]">
        <DownloadCloud className="w-3.5 h-3.5 text-[var(--semantic-win)] animate-pulse shrink-0" />
        <span>
          新バージョン <span className="font-num font-semibold">v{state.version}</span> を検出しました —{" "}
          {state.phase === "installing"
            ? "アップデートを適用して再起動しています..."
            : `自動ダウンロード中${state.percent !== undefined ? ` (${state.percent}%)` : "..."}`}
        </span>
      </div>

      {state.percent !== undefined && (
        <div className="w-32 h-1 bg-white/10 rounded-full overflow-hidden shrink-0">
          <div
            className="h-full bg-[var(--semantic-win)] transition-all duration-150"
            style={{ width: `${state.percent}%` }}
          />
        </div>
      )}
    </div>
  );
}

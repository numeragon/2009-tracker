import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

const INTERACTIVE_SELECTOR =
  "button, a, input, select, textarea, label, [role='button'], [data-no-drag]";

/**
 * Initiates native Win32 window drag on single left-click and maximize toggle on double-click
 * when clicking empty areas of the custom `#000000` header bar.
 */
export function handleTitlebarMouseDown(e: ReactMouseEvent<HTMLElement>) {
  if (e.button !== 0 || !isTauri()) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest(INTERACTIVE_SELECTOR)) return;

  const appWindow = getCurrentWindow();
  if (e.detail === 2) {
    e.preventDefault();
    void appWindow.toggleMaximize();
  } else {
    void appWindow.startDragging();
  }
}

export function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    const appWindow = getCurrentWindow();
    let active = true;

    const syncMaximized = () => {
      appWindow
        .isMaximized()
        .then((m) => {
          if (active) setIsMaximized(m);
        })
        .catch(() => {});
    };

    syncMaximized();
    let unlisten: (() => void) | null = null;
    void appWindow
      .onResized(() => {
        syncMaximized();
      })
      .then((fn) => {
        if (!active) fn();
        else unlisten = fn;
      });

    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, []);

  const handleMinimize = () => {
    if (!isTauri()) return;
    void getCurrentWindow().minimize();
  };

  const handleToggleMaximize = () => {
    if (!isTauri()) return;
    void getCurrentWindow()
      .toggleMaximize()
      .then(() => getCurrentWindow().isMaximized())
      .then((m) => setIsMaximized(m))
      .catch(() => {});
  };

  const handleClose = () => {
    if (!isTauri()) return;
    void invoke("window_close_or_tray").catch(() => {
      void getCurrentWindow().close();
    });
  };

  return (
    <div className="flex items-stretch h-full shrink-0 select-none" data-no-drag>
      {/* Minimize */}
      <button
        type="button"
        onClick={handleMinimize}
        aria-label="最小化"
        title="最小化"
        className="w-11 h-full flex items-center justify-center text-[#8f8f8f] hover:text-[#ededed] hover:bg-white/[0.08] active:bg-white/[0.12] transition-colors duration-100 cursor-pointer"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M1 5.5H9" stroke="currentColor" strokeWidth="1.15" strokeLinecap="square" />
        </svg>
      </button>

      {/* Maximize / Restore */}
      <button
        type="button"
        onClick={handleToggleMaximize}
        aria-label={isMaximized ? "元に戻す" : "最大化"}
        title={isMaximized ? "元に戻す" : "最大化"}
        className="w-11 h-full flex items-center justify-center text-[#8f8f8f] hover:text-[#ededed] hover:bg-white/[0.08] active:bg-white/[0.12] transition-colors duration-100 cursor-pointer"
      >
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <path
              d="M3 1.5H8.5V7M1.5 3H7V8.5H1.5V3Z"
              stroke="currentColor"
              strokeWidth="1.1"
            />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
            <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        )}
      </button>

      {/* Close */}
      <button
        type="button"
        onClick={handleClose}
        aria-label="閉じる"
        title="閉じる"
        className="w-11 h-full flex items-center justify-center text-[#8f8f8f] hover:text-white hover:bg-[#242424] active:bg-[#2f2f2f] transition-colors duration-100 cursor-pointer"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path
            d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5"
            stroke="currentColor"
            strokeWidth="1.15"
          />
        </svg>
      </button>
    </div>
  );
}

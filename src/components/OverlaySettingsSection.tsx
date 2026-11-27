import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff, Keyboard, Loader2, MonitorPlay } from "lucide-react";
import {
  replayGetState,
  replaySuspendHotkeys,
  replayUpdateConfig,
  type ReplayState,
} from "../lib/replayApi";
import { loadOverlaySettings, saveOverlaySettings } from "../lib/overlaySettings";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 cursor-pointer rounded-full border transition-colors duration-150 ${
        checked
          ? "border-[#ededed] bg-[#ededed]"
          : "border-[rgba(255,255,255,0.14)] bg-[#161616]"
      }`}
    >
      <span
        className={`block h-4 w-4 rounded-full transition-transform duration-150 ${
          checked ? "translate-x-5 bg-[#0a0a0a]" : "translate-x-1 bg-[#8f8f8f]"
        }`}
      />
    </button>
  );
}

export function OverlaySettingsSection() {
  const [state, setState] = useState<ReplayState | null>(null);
  const stateRef = useRef<ReplayState | null>(null);
  const [autoShow, setAutoShow] = useState(() => loadOverlaySettings().autoShow);
  const [capturing, setCapturing] = useState(false);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    void replayGetState()
      .then((next) => {
        if (cancelled) return;
        stateRef.current = next;
        setState(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    void invoke<boolean>("overlay_is_visible")
      .then((next) => {
        if (!cancelled) setVisible(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAutoShow = useCallback((enabled: boolean) => {
    setAutoShow(enabled);
    saveOverlaySettings({ autoShow: enabled });
    if (isTauriRuntime()) {
      void invoke("overlay_set_auto_show", { enabled }).catch(() => {});
    }
  }, []);

  // Capture in the settings webview instead of polling Win32 key state. This
  // reliably preserves modifier keys such as Alt while global hotkeys are
  // temporarily unregistered.
  useEffect(() => {
    if (!capturing || !isTauriRuntime()) return;
    let cancelled = false;
    let armed = false;
    let busy = false;
    let suspended = false;
    void replaySuspendHotkeys(true)
      .then(() => {
        if (cancelled) {
          void replaySuspendHotkeys(false).catch(() => {});
          return;
        }
        suspended = true;
        armed = true;
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setCapturing(false);
        }
      });

    const resumeHotkeys = async () => {
      if (!suspended) return;
      suspended = false;
      await replaySuspendHotkeys(false).catch(() => {});
    };

    const handleKeyDown = async (event: KeyboardEvent) => {
      if (!armed || busy || event.repeat) return;
      if (["Alt", "Control", "Shift", "Meta"].includes(event.key)) {
        event.preventDefault();
        return;
      }
      const vk = event.keyCode;
      if (!vk) return;

      event.preventDefault();
      event.stopPropagation();
      busy = true;
      armed = false;
      await resumeHotkeys();
      if (cancelled) return;

      if (vk === 0x1b) {
        setCapturing(false);
        return;
      }

      const clearKey =
        (vk === 0x08 || vk === 0x2e) &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.shiftKey;
      const nextVk = clearKey ? 0 : vk;
      const nextMods = clearKey
        ? 0
        : (event.altKey ? 0x1 : 0) |
          (event.ctrlKey ? 0x2 : 0) |
          (event.shiftKey ? 0x4 : 0);
      const current = stateRef.current;

      if (current) {
        try {
          const updated = await replayUpdateConfig({
            ...current.config,
            overlayVk: nextVk,
            overlayMods: nextMods,
          });
          if (!cancelled) {
            stateRef.current = updated;
            setState(updated);
            setError(null);
          }
        } catch (err) {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }
      }
      if (!cancelled) setCapturing(false);
    };

    window.addEventListener("keydown", handleKeyDown, true);

    return () => {
      cancelled = true;
      window.removeEventListener("keydown", handleKeyDown, true);
      void resumeHotkeys();
    };
  }, [capturing]);

  const hotkeyLabel =
    state?.hotkeyLabels?.overlayToggle || (state ? "未設定" : "読み込み中…");

  const handleToggleOverlay = async () => {
    if (!isTauriRuntime()) {
      setError("オーバーレイはデスクトップアプリ（.exe）でのみ利用できます。");
      return;
    }
    try {
      const next = await invoke<boolean>("overlay_toggle");
      setVisible(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="vt-panel p-6 mb-6">
      <div className="flex items-center gap-2.5">
        <MonitorPlay className="w-4 h-4 text-[#8f8f8f]" />
        <h2 className="text-sm font-medium text-[#ededed]">ゲーム内オーバーレイ</h2>
      </div>
      <p className="text-xs text-[#8f8f8f] mt-2 leading-relaxed">
        エージェント選択が始まると、両チームのパーティ・ランク・K/D・ピック状況を画面中央に表示します。
        プレイヤーにカーソルを合わせると、装備中の全武器スキンをホバー表示します。ゲームには一切干渉しません（クリックはゲームに通ります）。
      </p>

      <div className="mt-5 space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-[#ededed]">エージェント選択時に自動表示</p>
            <p className="text-[11px] text-[#5c5c5c] mt-0.5">
              ピック画面に入ると表示し、試合開始で自動的に隠します。
            </p>
          </div>
          <ToggleSwitch checked={autoShow} onChange={handleAutoShow} />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs text-[#ededed]">表示 / 非表示ショートカット</p>
            <p className="text-[11px] text-[#5c5c5c] mt-0.5">
              ゲーム中でも使えるグローバルキーです。クリックして入力、Esc でキャンセル、Backspace / Delete で解除。
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!isTauriRuntime()) {
                setError("ショートカットの変更はデスクトップアプリ（.exe）でのみ利用できます。");
                return;
              }
              setError(null);
              setCapturing(true);
            }}
            disabled={!state || capturing}
            className={`inline-flex h-9 min-w-[128px] shrink-0 items-center justify-center gap-1.5 rounded-[10px] border px-3 font-num text-xs transition-colors duration-150 ${
              capturing
                ? "border-white/25 bg-white/[0.06] text-[#ededed]"
                : "border-[rgba(255,255,255,0.12)] bg-[#0a0a0a] text-[#8f8f8f] hover:border-white/25 hover:text-[#ededed] cursor-pointer"
            }`}
          >
            {capturing ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                入力待ち…
              </>
            ) : (
              <>
                <Keyboard className="h-3.5 w-3.5" />
                {hotkeyLabel}
              </>
            )}
          </button>
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-[rgba(255,255,255,0.06)] pt-4">
          <p className="text-[11px] leading-relaxed text-[#5c5c5c]">
            VALORANT の表示モードが「フルスクリーン（排他）」の場合、オーバーレイが表示されないことがあります。
            「ウィンドウフルスクリーン」に設定してください。
          </p>
          <button
            type="button"
            onClick={() => void handleToggleOverlay()}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] border border-[rgba(255,255,255,0.12)] bg-[#0a0a0a] px-3.5 text-xs text-[#8f8f8f] transition-colors duration-150 hover:border-white/25 hover:text-[#ededed] cursor-pointer"
          >
            {visible ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
            {visible ? "今すぐ隠す" : "今すぐ表示"}
          </button>
        </div>

        {error && (
          <p className="text-[11px] leading-relaxed text-[var(--semantic-loss)]">
            {error}
          </p>
        )}
        {state && state.failedHotkeys.length > 0 && (
          <p className="text-[11px] leading-relaxed text-[#8f8f8f]">
            登録できなかったショートカット: {state.failedHotkeys.join(", ")}
            （他のアプリと競合しています）
          </p>
        )}
      </div>
    </section>
  );
}

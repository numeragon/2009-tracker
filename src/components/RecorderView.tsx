import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  Disc,
  Film,
  FolderOpen,
  Gamepad2,
  HardDrive,
  Headphones,
  Keyboard,
  Mic,
  Monitor,
  Pause,
  Play,
  Sliders,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import {
  formatBytes,
  formatSecsLabel,
  onReplayClipSaved,
  onReplaySaveFailed,
  onReplayStateChanged,
  replayGetState,
  replayOpenFolder,
  replayPickFolder,
  replayPollPressedKey,
  replayRevealFile,
  replaySaveNow,
  replaySetAutostart,
  replaySuspendHotkeys,
  replayUpdateConfig,
  type CaptureMode,
  type RecorderConfig,
  type ReplayState,
} from "../lib/replayApi";

type RecorderSubTab = "video" | "audio" | "hotkeys" | "general";
type HotkeyTarget = "saveClip" | "toggleRecording" | "openEditor" | "openFolder";

interface RecorderViewProps {
  onOpenClipStudio: () => void;
}

const DURATION_PRESETS = [15, 30, 60, 120, 300];
const BITRATE_PRESETS: Array<{ mbps: number; label: string; desc: string }> = [
  { mbps: 15, label: "軽量", desc: "15 Mbps" },
  { mbps: 30, label: "標準", desc: "30 Mbps" },
  { mbps: 60, label: "高画質", desc: "60 Mbps" },
];
const RESOLUTION_OPTIONS: Array<{ val: number; label: string }> = [
  { val: 0, label: "モニター解像度" },
  { val: 1440, label: "1440p" },
  { val: 1080, label: "1080p" },
  { val: 720, label: "720p" },
];
const FPS_OPTIONS = [30, 60, 120];

export function RecorderView({ onOpenClipStudio }: RecorderViewProps) {
  const [state, setState] = useState<ReplayState | null>(null);
  const [subTab, setSubTab] = useState<RecorderSubTab>("video");
  const [customDuration, setCustomDuration] = useState(false);
  const [customBitrate, setCustomBitrate] = useState(false);
  const [capturingKey, setCapturingKey] = useState<HotkeyTarget | null>(null);
  const [toast, setToast] = useState<{
    ok: boolean;
    text: string;
    filePath?: string;
  } | null>(null);
  const [isSavingClip, setIsSavingClip] = useState(false);

  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback((ok: boolean, text: string, filePath?: string) => {
    setToast({ ok, text, filePath });
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
    }, 5500);
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const next = await replayGetState();
      setState(next);
      if (!DURATION_PRESETS.includes(next.config.seconds)) {
        setCustomDuration(true);
      }
      if (!BITRATE_PRESETS.some((p) => p.mbps === next.config.bitrateMbps)) {
        setCustomBitrate(true);
      }
    } catch (err) {
      showToast(false, err instanceof Error ? err.message : String(err));
    }
  }, [showToast]);

  useEffect(() => {
    void refreshState();
    const unsubs: Array<() => void> = [];
    let active = true;

    void Promise.all([
      onReplayStateChanged(() => {
        if (active) void refreshState();
      }),
      onReplayClipSaved((ev) => {
        if (!active) return;
        setIsSavingClip(false);
        showToast(true, `クリップを保存しました: ${ev.title}`, ev.path);
      }),
      onReplaySaveFailed((msg) => {
        if (!active) return;
        setIsSavingClip(false);
        showToast(false, msg);
      }),
    ]).then((fns) => {
      if (!active) {
        fns.forEach((f) => f());
      } else {
        unsubs.push(...fns);
      }
    });

    return () => {
      active = false;
      unsubs.forEach((f) => f());
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, [refreshState, showToast]);

  const applyConfigPatch = useCallback(
    async (patch: Partial<RecorderConfig>) => {
      if (!state) return;
      const optimistic: RecorderConfig = { ...state.config, ...patch };
      setState((prev) => (prev ? { ...prev, config: optimistic } : prev));
      try {
        const updated = await replayUpdateConfig(optimistic);
        setState(updated);
      } catch (err) {
        showToast(false, err instanceof Error ? err.message : String(err));
        void refreshState();
      }
    },
    [state, refreshState, showToast],
  );

  // Interactive Win32 Global Hotkey Capture Loop (matches Clippy's `pressed_key()`)
  useEffect(() => {
    if (!capturingKey || !state) return;
    let cancelled = false;
    let armed = false;

    void replaySuspendHotkeys(true);

    const timer = window.setInterval(async () => {
      if (cancelled) return;
      const pressed = await replayPollPressedKey().catch(() => null);
      if (!armed) {
        // Wait until all keys from the click/previous press are released first
        if (!pressed) {
          armed = true;
        }
        return;
      }
      if (!pressed) return;

      cancelled = true;
      window.clearInterval(timer);
      setCapturingKey(null);

      // Esc (0x1B) cancels binding
      if (pressed.vk === 0x1b) {
        await replaySuspendHotkeys(false).catch(() => {});
        return;
      }

      // Backspace (0x08) or Delete (0x2E) clears optional shortcuts
      const isClearKey =
        (pressed.vk === 0x08 || pressed.vk === 0x2e) &&
        pressed.mods === 0 &&
        capturingKey !== "saveClip";

      const vk = isClearKey ? 0 : pressed.vk;
      const mods = isClearKey ? 0 : pressed.mods;

      const patch: Partial<RecorderConfig> = {};
      if (capturingKey === "saveClip") {
        patch.hotkeyVk = vk;
        patch.hotkeyMods = mods;
      } else if (capturingKey === "toggleRecording") {
        patch.toggleVk = vk;
        patch.toggleMods = mods;
      } else if (capturingKey === "openEditor") {
        patch.editorVk = vk;
        patch.editorMods = mods;
      } else if (capturingKey === "openFolder") {
        patch.folderVk = vk;
        patch.folderMods = mods;
      }

      await replaySuspendHotkeys(false).catch(() => {});
      await applyConfigPatch(patch);
    }, 40);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      void replaySuspendHotkeys(false).catch(() => {});
    };
  }, [capturingKey, state, applyConfigPatch]);

  const handleSaveClipNow = async () => {
    setIsSavingClip(true);
    try {
      await replaySaveNow();
    } catch (err) {
      setIsSavingClip(false);
      showToast(false, err instanceof Error ? err.message : String(err));
    }
  };

  if (!state) {
    return (
      <div className="max-w-4xl mx-auto py-10 px-6 space-y-4">
        <div className="h-36 rounded-[12px] bg-[#0a0a0a]/80 vt-hairline animate-pulse" />
        <div className="h-72 rounded-[12px] bg-[#0a0a0a]/80 vt-hairline animate-pulse" />
      </div>
    );
  }

  const { config } = state;
  const isRecordingActive = config.enabled && !state.error;
  const estimatedClipBytes =
    ((config.bitrateMbps * 1_000_000 + 192_000) * config.seconds) / 8;

  return (
    <div className="max-w-4xl mx-auto py-8 px-6 space-y-6">
      {/* Toast Notification */}
      {toast && (
        <div
          className={`rounded-[12px] px-4 py-3 vt-hairline flex items-center justify-between gap-3 backdrop-blur-md ${
            toast.ok
              ? "bg-[#111111]/92 text-[#ededed]"
              : "bg-[#191212]/92 text-[#ededed] border-white/20"
          }`}
        >
          <div className="flex items-center gap-2.5 text-xs min-w-0">
            {toast.ok ? (
              <Check className="w-4 h-4 text-[#ededed] shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-[#ededed] shrink-0" />
            )}
            <span className="truncate">{toast.text}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {toast.filePath && (
              <>
                <button
                  type="button"
                  onClick={onOpenClipStudio}
                  className="px-2.5 py-1 rounded-[8px] bg-[#ededed] text-[#0a0a0a] text-[11px] font-medium hover:bg-white transition-colors cursor-pointer"
                >
                  編集する
                </button>
                <button
                  type="button"
                  onClick={() => void replayRevealFile(toast.filePath!)}
                  className="px-2.5 py-1 rounded-[8px] bg-white/[0.06] text-[#ededed] text-[11px] hover:bg-white/[0.11] transition-colors cursor-pointer"
                >
                  フォルダで表示
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => setToast(null)}
              className="p-1 text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Hero Instant Replay Card (Clippy's signature Keycap + Live Status) */}
      <section className="rounded-[12px] bg-[#0a0a0a]/84 backdrop-blur-md vt-hairline p-6">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          {/* Left: Tactile Keycap + Replay Description */}
          <div className="flex items-center gap-5">
            <button
              type="button"
              onClick={() =>
                setCapturingKey(capturingKey === "saveClip" ? null : "saveClip")
              }
              title="クリックして保存ショートカットキーを変更"
              className={`group relative min-w-[92px] h-[74px] px-4 rounded-[12px] border transition-all duration-150 flex flex-col items-center justify-center cursor-pointer ${
                capturingKey === "saveClip"
                  ? "bg-[#ededed] text-[#0a0a0a] border-white"
                  : "bg-[#141414] hover:bg-[#1a1a1a] text-[#ededed] border-[rgba(255,255,255,0.16)] border-b-[4px]"
              }`}
            >
              <span className="font-num text-lg font-semibold tracking-tight">
                {capturingKey === "saveClip" ? "入力待ち…" : state.hotkeyLabels.saveClip}
              </span>
              <span
                className={`text-[10px] mt-0.5 ${
                  capturingKey === "saveClip"
                    ? "text-[#0a0a0a]/70"
                    : "text-[#8f8f8f] group-hover:text-[#ededed]"
                }`}
              >
                {capturingKey === "saveClip" ? "Escで取消" : "キー変更"}
              </span>
            </button>

            <div className="space-y-1.5">
              <div className="flex items-center gap-2.5 flex-wrap">
                <span
                  className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${
                    isRecordingActive
                      ? "bg-white/[0.08] text-[#ededed] border-white/20"
                      : "bg-white/[0.03] text-[#8f8f8f] border-white/[0.08]"
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full ${
                      isRecordingActive ? "bg-[#ededed] animate-pulse" : "bg-[#5c5c5c]"
                    }`}
                  />
                  {state.error
                    ? "録画エラー（自動再試行中）"
                    : config.enabled
                      ? "インスタントリプレイ稼働中"
                      : "一時停止中"}
                </span>

                {config.enabled && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] bg-white/[0.04] text-[#8f8f8f] border border-white/[0.08]">
                    <Gamepad2 className="w-3 h-3" />
                    {state.detectedGame
                      ? `検出中: ${state.detectedGame}`
                      : config.captureMode === "games"
                        ? "フルスクリーンゲーム待機中"
                        : "画面全体キャプチャ"}
                  </span>
                )}
              </div>

              <h1 className="text-base font-semibold text-[#ededed] tracking-tight">
                試合中に{" "}
                <span className="font-num px-1.5 py-0.5 rounded bg-white/[0.07] text-[#ededed]">
                  {state.hotkeyLabels.saveClip}
                </span>{" "}
                を押すと、直近{" "}
                <span className="font-num">{formatSecsLabel(config.seconds)}</span>{" "}
                を無劣化MP4として即座に保存
              </h1>

              <p className="text-xs text-[#8f8f8f] flex items-center gap-3 flex-wrap font-num">
                <span>
                  GPU: {state.encoderName ?? (config.enabled ? "初期化中…" : "停止中")}
                </span>
                <span>·</span>
                <span>推定メモリ: ~{state.typicalRamMb} MB RAM</span>
                <span>·</span>
                <span>1クリップ目安: ~{formatBytes(estimatedClipBytes)}</span>
              </p>
            </div>
          </div>

          {/* Right: Master Actions */}
          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              disabled={!isRecordingActive || isSavingClip}
              onClick={() => void handleSaveClipNow()}
              className="h-9 px-3.5 rounded-[10px] bg-[#ededed] text-[#0a0a0a] text-xs font-medium hover:bg-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2 cursor-pointer"
            >
              <Disc className="w-3.5 h-3.5" />
              <span>{isSavingClip ? "保存中…" : "今すぐ保存"}</span>
            </button>

            <button
              type="button"
              onClick={onOpenClipStudio}
              className="h-9 px-3.5 rounded-[10px] bg-[#141414] hover:bg-[#1c1c1c] text-[#ededed] text-xs font-medium vt-hairline transition-colors flex items-center gap-2 cursor-pointer"
            >
              <Film className="w-3.5 h-3.5" />
              <span>クリップ編集</span>
            </button>

            <button
              type="button"
              onClick={() => void applyConfigPatch({ enabled: !config.enabled })}
              title={config.enabled ? "録画を一時停止する" : "録画を再開する"}
              className={`h-9 px-3 rounded-[10px] text-xs font-medium vt-hairline transition-colors flex items-center gap-1.5 cursor-pointer ${
                config.enabled
                  ? "bg-white/[0.08] text-[#ededed] hover:bg-white/[0.12]"
                  : "bg-[#141414] text-[#8f8f8f] hover:text-[#ededed]"
              }`}
            >
              {config.enabled ? (
                <>
                  <Pause className="w-3.5 h-3.5" />
                  <span>ON</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  <span>OFF</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Error or Hotkey Conflict Alerts */}
        {(state.error || state.failedHotkeys.length > 0) && (
          <div className="mt-4 pt-4 vt-hairline-t space-y-2">
            {state.error && (
              <div className="flex items-center gap-2 text-xs text-[#ededed] bg-white/[0.04] rounded-[10px] px-3 py-2 border border-white/15">
                <AlertTriangle className="w-4 h-4 text-[#8f8f8f] shrink-0" />
                <span>録画エンジンの状態: {state.error}（自動で再接続を試行します）</span>
              </div>
            )}
            {state.failedHotkeys.length > 0 && (
              <div className="flex items-center gap-2 text-xs text-[#ededed] bg-white/[0.04] rounded-[10px] px-3 py-2 border border-white/15">
                <AlertTriangle className="w-4 h-4 text-[#8f8f8f] shrink-0" />
                <span>
                  他のアプリと競合しているショートカット: {state.failedHotkeys.join(", ")}{" "}
                  （「ショートカット」タブから変更してください）
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Sub-Navigation Tabs (映像 / 音声ミキサー / ショートカット / 一般) */}
      <div className="flex items-center gap-1 p-1 rounded-[12px] bg-[#0a0a0a]/84 backdrop-blur-md vt-hairline w-fit">
        {(
          [
            { id: "video", label: "映像・品質", icon: Monitor },
            { id: "audio", label: "音声ミキサー (3ch)", icon: Headphones },
            { id: "hotkeys", label: "ショートカット", icon: Keyboard },
            { id: "general", label: "保存先・一般", icon: Sliders },
          ] as const
        ).map((tab) => {
          const Icon = tab.icon;
          const active = subTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setSubTab(tab.id)}
              className={`px-3.5 py-2 rounded-[9px] text-xs flex items-center gap-2 transition-colors cursor-pointer ${
                active
                  ? "bg-white/[0.09] text-[#ededed] font-medium"
                  : "text-[#8f8f8f] hover:text-[#ededed]"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: VIDEO SETTINGS */}
      {subTab === "video" && (
        <section className="rounded-[12px] bg-[#0a0a0a]/84 backdrop-blur-md vt-hairline divide-y divide-[rgba(255,255,255,0.08)]">
          {/* Capture Mode */}
          <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1">
              <div className="text-sm font-medium text-[#ededed]">キャプチャ対象</div>
              <p className="text-xs text-[#8f8f8f]">
                {config.captureMode === "games"
                  ? "フルスクリーン / ボーダレスのゲーム画面のみを録画します（Alt+Tab中は黒画面になります）"
                  : "ゲームが起動しているモニター全体（デスクトップ含む）をそのまま録画します"}
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 rounded-[10px] bg-[#111111] vt-hairline shrink-0">
              {(
                [
                  { id: "screen", label: "画面全体", icon: Monitor },
                  { id: "games", label: "ゲームのみ", icon: Gamepad2 },
                ] as Array<{ id: CaptureMode; label: string; icon: typeof Monitor }>
              ).map((m) => {
                const Icon = m.icon;
                const selected = config.captureMode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => void applyConfigPatch({ captureMode: m.id })}
                    className={`px-3 py-1.5 rounded-[8px] text-xs flex items-center gap-1.5 transition-colors cursor-pointer ${
                      selected
                        ? "bg-[#ededed] text-[#0a0a0a] font-medium"
                        : "text-[#8f8f8f] hover:text-[#ededed]"
                    }`}
                  >
                    <Icon className="w-3.5 h-3.5" />
                    <span>{m.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Replay Buffer Duration */}
          <div className="p-5 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="text-sm font-medium text-[#ededed]">リプレイ保存時間</div>
                <p className="text-xs text-[#8f8f8f]">
                  キーを押した瞬間から何秒前まで遡って保存するか設定します（バッファを切らず即時変更）
                </p>
              </div>
              <div className="flex items-center gap-1 p-1 rounded-[10px] bg-[#111111] vt-hairline shrink-0 flex-wrap">
                {DURATION_PRESETS.map((sec) => {
                  const selected = !customDuration && config.seconds === sec;
                  return (
                    <button
                      key={sec}
                      type="button"
                      onClick={() => {
                        setCustomDuration(false);
                        void applyConfigPatch({ seconds: sec });
                      }}
                      className={`px-2.5 py-1.5 rounded-[8px] text-xs font-num transition-colors cursor-pointer ${
                        selected
                          ? "bg-[#ededed] text-[#0a0a0a] font-medium"
                          : "text-[#8f8f8f] hover:text-[#ededed]"
                      }`}
                    >
                      {formatSecsLabel(sec)}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setCustomDuration(true)}
                  className={`px-2.5 py-1.5 rounded-[8px] text-xs transition-colors cursor-pointer ${
                    customDuration
                      ? "bg-[#ededed] text-[#0a0a0a] font-medium"
                      : "text-[#8f8f8f] hover:text-[#ededed]"
                  }`}
                >
                  カスタム
                </button>
              </div>
            </div>

            {customDuration && (
              <div className="pt-2 flex items-center gap-4">
                <input
                  type="range"
                  min={5}
                  max={300}
                  step={5}
                  value={config.seconds}
                  onChange={(e) =>
                    setState((prev) =>
                      prev
                        ? { ...prev, config: { ...prev.config, seconds: Number(e.target.value) } }
                        : prev,
                    )
                  }
                  onMouseUp={() => void applyConfigPatch({ seconds: config.seconds })}
                  onTouchEnd={() => void applyConfigPatch({ seconds: config.seconds })}
                  className="flex-1 accent-[#ededed] cursor-pointer"
                />
                <span className="font-num text-xs text-[#ededed] w-20 text-right">
                  {formatSecsLabel(config.seconds)} ({config.seconds}s)
                </span>
              </div>
            )}
          </div>

          {/* Quality / Bitrate */}
          <div className="p-5 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="text-sm font-medium text-[#ededed]">画質（ビットレート）</div>
                <p className="text-xs text-[#8f8f8f]">
                  GPUハードウェア H.264 VBR エンコード（変更時は録画バッファがリセットされます）
                </p>
              </div>
              <div className="flex items-center gap-1 p-1 rounded-[10px] bg-[#111111] vt-hairline shrink-0 flex-wrap">
                {BITRATE_PRESETS.map((p) => {
                  const selected = !customBitrate && config.bitrateMbps === p.mbps;
                  return (
                    <button
                      key={p.mbps}
                      type="button"
                      onClick={() => {
                        setCustomBitrate(false);
                        void applyConfigPatch({ bitrateMbps: p.mbps });
                      }}
                      className={`px-3 py-1.5 rounded-[8px] text-xs transition-colors cursor-pointer ${
                        selected
                          ? "bg-[#ededed] text-[#0a0a0a] font-medium"
                          : "text-[#8f8f8f] hover:text-[#ededed]"
                      }`}
                    >
                      {p.label}{" "}
                      <span className="font-num opacity-75">({p.mbps}M)</span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setCustomBitrate(true)}
                  className={`px-3 py-1.5 rounded-[8px] text-xs transition-colors cursor-pointer ${
                    customBitrate
                      ? "bg-[#ededed] text-[#0a0a0a] font-medium"
                      : "text-[#8f8f8f] hover:text-[#ededed]"
                  }`}
                >
                  カスタム
                </button>
              </div>
            </div>

            {customBitrate && (
              <div className="pt-2 flex items-center gap-4">
                <input
                  type="range"
                  min={5}
                  max={150}
                  step={5}
                  value={config.bitrateMbps}
                  onChange={(e) =>
                    setState((prev) =>
                      prev
                        ? {
                            ...prev,
                            config: { ...prev.config, bitrateMbps: Number(e.target.value) },
                          }
                        : prev,
                    )
                  }
                  onMouseUp={() => void applyConfigPatch({ bitrateMbps: config.bitrateMbps })}
                  onTouchEnd={() => void applyConfigPatch({ bitrateMbps: config.bitrateMbps })}
                  className="flex-1 accent-[#ededed] cursor-pointer"
                />
                <span className="font-num text-xs text-[#ededed] w-20 text-right">
                  {config.bitrateMbps} Mbps
                </span>
              </div>
            )}
          </div>

          {/* Resolution */}
          <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="text-sm font-medium text-[#ededed]">出力解像度</div>
              <p className="text-xs text-[#8f8f8f]">
                4:3 引き伸ばし解像度のVALORANTもモニター比率に合わせて自動補正されます
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 rounded-[10px] bg-[#111111] vt-hairline shrink-0 flex-wrap">
              {RESOLUTION_OPTIONS.map((opt) => {
                const selected = config.resolution === opt.val;
                return (
                  <button
                    key={opt.val}
                    type="button"
                    onClick={() => void applyConfigPatch({ resolution: opt.val })}
                    className={`px-3 py-1.5 rounded-[8px] text-xs font-num transition-colors cursor-pointer ${
                      selected
                        ? "bg-[#ededed] text-[#0a0a0a] font-medium"
                        : "text-[#8f8f8f] hover:text-[#ededed]"
                    }`}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* FPS */}
          <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="text-sm font-medium text-[#ededed]">フレームレート</div>
              <p className="text-xs text-[#8f8f8f]">
                1秒あたりのフレーム数（DXGI Desktop Duplication ゼロCPU負荷キャプチャ）
              </p>
            </div>
            <div className="flex items-center gap-1 p-1 rounded-[10px] bg-[#111111] vt-hairline shrink-0">
              {FPS_OPTIONS.map((fps) => {
                const selected = config.fps === fps;
                return (
                  <button
                    key={fps}
                    type="button"
                    onClick={() => void applyConfigPatch({ fps })}
                    className={`px-3.5 py-1.5 rounded-[8px] text-xs font-num transition-colors cursor-pointer ${
                      selected
                        ? "bg-[#ededed] text-[#0a0a0a] font-medium"
                        : "text-[#8f8f8f] hover:text-[#ededed]"
                    }`}
                  >
                    {fps} fps
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      )}

      {/* TAB 2: 3-CHANNEL AUDIO MIXER */}
      {subTab === "audio" && (
        <section className="rounded-[12px] bg-[#0a0a0a]/84 backdrop-blur-md vt-hairline divide-y divide-[rgba(255,255,255,0.08)]">
          {/* Channel 1: Game Audio */}
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-[10px] bg-white/[0.05] vt-hairline flex items-center justify-center">
                  <Gamepad2 className="w-4 h-4 text-[#ededed]" />
                </div>
                <div>
                  <div className="text-sm font-medium text-[#ededed]">ゲーム音声（プロセス分離）</div>
                  <p className="text-xs text-[#8f8f8f]">
                    フルスクリーンゲームのプロセス音声だけを独立してキャプチャします
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={config.gameAudio}
                onChange={(v) => void applyConfigPatch({ gameAudio: v })}
              />
            </div>
            {config.gameAudio && (
              <VolumeSliderRow
                value={config.gameVolume}
                max={100}
                onChange={(v) =>
                  setState((prev) =>
                    prev ? { ...prev, config: { ...prev.config, gameVolume: v } } : prev,
                  )
                }
                onCommit={(v) => void applyConfigPatch({ gameVolume: v })}
              />
            )}
          </div>

          {/* Channel 2: Desktop Audio */}
          <div className="p-5 space-y-3">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-[10px] bg-white/[0.05] vt-hairline flex items-center justify-center">
                  <Headphones className="w-4 h-4 text-[#ededed]" />
                </div>
                <div>
                  <div className="text-sm font-medium text-[#ededed]">
                    デスクトップ音声（Discord・音楽など）
                  </div>
                  <p className="text-xs text-[#8f8f8f]">
                    ゲーム以外のシステム音声を分離録音するため、ゲームの音量が二重になりません
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={config.desktopAudio}
                onChange={(v) => void applyConfigPatch({ desktopAudio: v })}
              />
            </div>
            {config.desktopAudio && (
              <VolumeSliderRow
                value={config.desktopVolume}
                max={100}
                onChange={(v) =>
                  setState((prev) =>
                    prev ? { ...prev, config: { ...prev.config, desktopVolume: v } } : prev,
                  )
                }
                onCommit={(v) => void applyConfigPatch({ desktopVolume: v })}
              />
            )}
          </div>

          {/* Channel 3: Microphone */}
          <div className="p-5 space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-[10px] bg-white/[0.05] vt-hairline flex items-center justify-center">
                  <Mic className="w-4 h-4 text-[#ededed]" />
                </div>
                <div>
                  <div className="text-sm font-medium text-[#ededed]">マイク音声（自分の声）</div>
                  <p className="text-xs text-[#8f8f8f]">
                    最大 200% までブースト可能・トレイメニューからもワンクリックでON/OFF切替可能
                  </p>
                </div>
              </div>
              <ToggleSwitch
                checked={config.micAudio}
                onChange={(v) => void applyConfigPatch({ micAudio: v })}
              />
            </div>

            {config.micAudio && (
              <div className="space-y-3 pl-12">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <span className="text-xs text-[#8f8f8f]">入力デバイス</span>
                  <select
                    value={config.micDevice}
                    onChange={(e) => void applyConfigPatch({ micDevice: e.target.value })}
                    className="h-9 px-3 rounded-[9px] bg-[#121212] text-[#ededed] text-xs vt-hairline outline-none max-w-xs w-full cursor-pointer"
                  >
                    <option value="">Windows の既定のマイク</option>
                    {state.microphones.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>

                <VolumeSliderRow
                  value={config.micVolume}
                  max={200}
                  onChange={(v) =>
                    setState((prev) =>
                      prev ? { ...prev, config: { ...prev.config, micVolume: v } } : prev,
                    )
                  }
                  onCommit={(v) => void applyConfigPatch({ micVolume: v })}
                />
              </div>
            )}
          </div>
        </section>
      )}

      {/* TAB 3: GLOBAL HOTKEYS */}
      {subTab === "hotkeys" && (
        <section className="rounded-[12px] bg-[#0a0a0a]/84 backdrop-blur-md vt-hairline divide-y divide-[rgba(255,255,255,0.08)]">
          <div className="px-5 py-3.5 text-xs text-[#8f8f8f]">
            グローバルショートカットはVALORANTのフルスクリーンプレイ中も常時反応します。変更中に{" "}
            <span className="font-num text-[#ededed]">Esc</span> でキャンセル、任意項目は{" "}
            <span className="font-num text-[#ededed]">Backspace / Delete</span> で解除できます。
          </div>

          {(
            [
              {
                id: "saveClip",
                title: "クリップを保存",
                desc: "直近のリプレイバッファをMP4ファイルとして即座に書き出します（必須）",
                label: state.hotkeyLabels.saveClip,
                vk: config.hotkeyVk,
                optional: false,
              },
              {
                id: "toggleRecording",
                title: "録画の一時停止 / 再開",
                desc: "ゲーム中から録画をON/OFF切り替え、効果音で状態を知らせます",
                label: state.hotkeyLabels.toggleRecording,
                vk: config.toggleVk,
                optional: true,
              },
              {
                id: "openEditor",
                title: "クリップ編集画面を開く",
                desc: "#2009 tracker を前面に表示してクリップ編集タブへ移動します",
                label: state.hotkeyLabels.openEditor,
                vk: config.editorVk,
                optional: true,
              },
              {
                id: "openFolder",
                title: "保存先フォルダを開く",
                desc: "クリップの保存フォルダをエクスプローラーで開きます",
                label: state.hotkeyLabels.openFolder,
                vk: config.folderVk,
                optional: true,
              },
            ] as Array<{
              id: HotkeyTarget;
              title: string;
              desc: string;
              label: string;
              vk: number;
              optional: boolean;
            }>
          ).map((row) => {
            const isListening = capturingKey === row.id;
            return (
              <div
                key={row.id}
                className="p-5 flex items-center justify-between gap-4"
              >
                <div className="space-y-0.5">
                  <div className="text-sm font-medium text-[#ededed]">{row.title}</div>
                  <p className="text-xs text-[#8f8f8f]">{row.desc}</p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => setCapturingKey(isListening ? null : row.id)}
                    className={`min-w-[120px] h-9 px-3.5 rounded-[9px] font-num text-xs font-medium border transition-colors cursor-pointer ${
                      isListening
                        ? "bg-[#ededed] text-[#0a0a0a] border-white"
                        : row.vk === 0
                          ? "bg-[#121212] text-[#5c5c5c] border-white/[0.08] hover:text-[#ededed]"
                          : "bg-[#161616] text-[#ededed] border-white/[0.15] hover:bg-[#1f1f1f]"
                    }`}
                  >
                    {isListening ? "キーを押してください…" : row.label}
                  </button>

                  {row.optional && row.vk !== 0 && !isListening && (
                    <button
                      type="button"
                      title="割り当て解除"
                      onClick={() => {
                        if (row.id === "toggleRecording") {
                          void applyConfigPatch({ toggleVk: 0, toggleMods: 0 });
                        } else if (row.id === "openEditor") {
                          void applyConfigPatch({ editorVk: 0, editorMods: 0 });
                        } else if (row.id === "openFolder") {
                          void applyConfigPatch({ folderVk: 0, folderMods: 0 });
                        }
                      }}
                      className="h-9 w-9 rounded-[9px] bg-[#121212] hover:bg-white/[0.08] text-[#8f8f8f] hover:text-[#ededed] vt-hairline flex items-center justify-center cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </section>
      )}

      {/* TAB 4: GENERAL & STORAGE */}
      {subTab === "general" && (
        <section className="rounded-[12px] bg-[#0a0a0a]/84 backdrop-blur-md vt-hairline divide-y divide-[rgba(255,255,255,0.08)]">
          {/* Output Folder */}
          <div className="p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <div className="text-sm font-medium text-[#ededed] flex items-center gap-2">
                <HardDrive className="w-4 h-4 text-[#8f8f8f]" />
                <span>クリップの保存先フォルダ</span>
              </div>
              <p className="text-xs text-[#8f8f8f] font-num truncate">{config.outputDir}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={async () => {
                  const picked = await replayPickFolder(config.outputDir);
                  if (picked) {
                    await applyConfigPatch({ outputDir: picked });
                  }
                }}
                className="h-9 px-3.5 rounded-[9px] bg-[#161616] hover:bg-[#1f1f1f] text-[#ededed] text-xs vt-hairline transition-colors cursor-pointer"
              >
                変更…
              </button>
              <button
                type="button"
                onClick={() => void replayOpenFolder(config.outputDir)}
                className="h-9 px-3.5 rounded-[9px] bg-[#161616] hover:bg-[#1f1f1f] text-[#ededed] text-xs vt-hairline transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>開く</span>
              </button>
            </div>
          </div>

          {/* Sound on Save */}
          <div className="p-5 flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="text-sm font-medium text-[#ededed]">クリップ保存時の通知音</div>
              <p className="text-xs text-[#8f8f8f]">
                保存完了時に短いチャイム音を鳴らします（保存される動画のデスクトップ音声からは自動で消去されます）
              </p>
            </div>
            <ToggleSwitch
              checked={config.soundOnSave}
              onChange={(v) => void applyConfigPatch({ soundOnSave: v })}
            />
          </div>

          {/* Minimize to Tray */}
          <div className="p-5 flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="text-sm font-medium text-[#ededed]">
                ウィンドウを閉じたときシステムトレイに格納
              </div>
              <p className="text-xs text-[#8f8f8f]">
                録画ON中に×ボタンを押してもアプリを終了せず、トレイ常駐でバックグラウンド録画を継続します
              </p>
            </div>
            <ToggleSwitch
              checked={config.minimizeToTray}
              onChange={(v) => void applyConfigPatch({ minimizeToTray: v })}
            />
          </div>

          {/* Start with Windows */}
          <div className="p-5 flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <div className="text-sm font-medium text-[#ededed]">Windows 起動時に自動開始</div>
              <p className="text-xs text-[#8f8f8f]">
                PC起動時にウィンドウを開かずシステムトレイで静かにインスタントリプレイ待機を開始します
              </p>
            </div>
            <ToggleSwitch
              checked={state.autostart}
              onChange={async (v) => {
                const enabled = await replaySetAutostart(v);
                setState((prev) => (prev ? { ...prev, autostart: enabled } : prev));
              }}
            />
          </div>

          {/* Open Source Attribution (GPL-3.0-or-later) */}
          <div className="px-5 py-3.5 text-[11px] text-[#5c5c5c] flex items-center justify-between gap-4 flex-wrap">
            <span>
              GPU Instant Replay & Media Foundation Engine based on open-source{" "}
              <span className="text-[#8f8f8f]">santiremedi/clippy</span> (GPL-3.0-or-later)
            </span>
            <span className="font-num">DXGI + D3D11 + WASAPI + MF H.264</span>
          </div>
        </section>
      )}
    </div>
  );
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
      className={`relative w-11 h-6 rounded-full transition-colors duration-150 shrink-0 cursor-pointer border ${
        checked
          ? "bg-[#ededed] border-[#ededed]"
          : "bg-[#161616] border-[rgba(255,255,255,0.14)]"
      }`}
    >
      <span
        className={`block w-4 h-4 rounded-full transition-transform duration-150 ${
          checked
            ? "translate-x-5 bg-[#0a0a0a]"
            : "translate-x-1 bg-[#8f8f8f]"
        }`}
      />
    </button>
  );
}

function VolumeSliderRow({
  value,
  max,
  onChange,
  onCommit,
}: {
  value: number;
  max: number;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  return (
    <div className="pl-12 flex items-center gap-3">
      {value === 0 ? (
        <VolumeX className="w-4 h-4 text-[#5c5c5c] shrink-0" />
      ) : (
        <Volume2 className="w-4 h-4 text-[#8f8f8f] shrink-0" />
      )}
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onMouseUp={() => onCommit(value)}
        onTouchEnd={() => onCommit(value)}
        className="flex-1 accent-[#ededed] cursor-pointer"
      />
      <span className="font-num text-xs text-[#ededed] w-12 text-right">{value}%</span>
    </div>
  );
}

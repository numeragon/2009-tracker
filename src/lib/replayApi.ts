import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const HNS_PER_SEC = 10_000_000;

export type CaptureMode = "screen" | "games";

export interface RecorderConfig {
  enabled: boolean;
  outputDir: string;
  seconds: number;
  hotkeyVk: number;
  hotkeyMods: number;
  fps: number;
  bitrateMbps: number;
  resolution: number;
  gameAudio: boolean;
  gameVolume: number;
  desktopAudio: boolean;
  desktopVolume: number;
  micAudio: boolean;
  micVolume: number;
  micDevice: string;
  captureMode: CaptureMode;
  soundOnSave: boolean;
  minimizeToTray: boolean;
  toggleVk: number;
  toggleMods: number;
  editorVk: number;
  editorMods: number;
  folderVk: number;
  folderMods: number;
}

export interface HotkeyLabels {
  saveClip: string;
  toggleRecording: string;
  openEditor: string;
  openFolder: string;
}

export interface MicrophoneDevice {
  id: string;
  name: string;
}

export interface ReplayState {
  config: RecorderConfig;
  encoderName: string | null;
  detectedGame: string | null;
  error: string | null;
  typicalRamMb: number;
  autostart: boolean;
  hotkeyLabels: HotkeyLabels;
  failedHotkeys: string[];
  microphones: MicrophoneDevice[];
}

export interface PressedKeyInfo {
  vk: number;
  mods: number;
  label: string;
}

export interface ClipSavedEvent {
  path: string;
  title: string;
}

export interface FolderItem {
  path: string;
  name: string;
  count: number;
}

export interface AssetItem {
  path: string;
  title: string;
  size: number;
  modifiedMs: number;
  imported: boolean;
}

export interface LibraryScan {
  rootDir: string;
  currentDir: string | null;
  folders: FolderItem[];
  assets: AssetItem[];
}

export interface ProbeInfo {
  duration100ns: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  codec: string;
  hasAudio: boolean;
}

export interface ClipInspect {
  path: string;
  probe: ProbeInfo;
  thumbPath: string | null;
  peaks: number[];
  rms: number[];
  keyframes: number[];
}

export type FadeCurveKind = "even" | "linear" | "smooth";
export type FrameSizingKind = "whole" | "fill" | "stretch";

export interface ClipPieceDto {
  id: number;
  path: string;
  start: number;
  len: number;
  srcIn: number;
  speed: number;
  fadeIn: number;
  fadeOut: number;
  gain: number;
  curveIn: FadeCurveKind;
  curveOut: FadeCurveKind;
  turns: number;
  flip: boolean;
  crop: [number, number, number, number];
  sizing: FrameSizingKind;
}

export interface ExportEditDto {
  videoTracks: ClipPieceDto[][];
  audioTracks: ClipPieceDto[][];
  ratio: [number, number] | null;
}

export type ExportQualityKind = "recommended" | "high" | "medium" | "low" | "maxsize";

export interface ExportRequestDto {
  edit: ExportEditDto;
  name: string;
  dir: string;
  height: number;
  fps: number;
  quality: ExportQualityKind;
  sizeMb: number;
}

export interface ExportPlanDto {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  constant: boolean;
  canLosslessCopy: boolean;
  estimatedBytes: number;
  durationSec: number;
  originalQuality: boolean;
  lowQualityWarning: boolean;
}

export interface ExportStatusDto {
  active: boolean;
  progress: number;
  outPath: string | null;
  finishedMode: string | null;
  error: string | null;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function toAssetUrl(filePath: string): string {
  if (!filePath) return "";
  if (isTauriRuntime()) {
    return convertFileSrc(filePath);
  }
  return filePath;
}

export function secToHns(sec: number): number {
  return Math.round(sec * HNS_PER_SEC);
}

export function hnsToSec(hns: number): number {
  return hns / HNS_PER_SEC;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number, showTenths = false): string {
  const s = Math.max(0, seconds);
  const mins = Math.floor(s / 60);
  const secs = Math.floor(s % 60);
  const tenths = Math.floor((s - Math.floor(s)) * 10);
  const base = `${mins}:${secs.toString().padStart(2, "0")}`;
  return showTenths ? `${base}.${tenths}` : base;
}

export function formatSecsLabel(secs: number): string {
  if (secs % 60 === 0 && secs >= 60) {
    return `${secs / 60}分`;
  }
  if (secs > 60) {
    return `${Math.floor(secs / 60)}分${secs % 60}秒`;
  }
  return `${secs}秒`;
}

// --- Tauri IPC wrappers ---

export async function replayGetState(): Promise<ReplayState> {
  return invoke<ReplayState>("replay_get_state");
}

export async function replayUpdateConfig(config: RecorderConfig): Promise<ReplayState> {
  return invoke<ReplayState>("replay_update_config", { config });
}

export async function replayToggleRecording(): Promise<ReplayState> {
  return invoke<ReplayState>("replay_toggle_recording");
}

export async function replaySaveNow(): Promise<void> {
  return invoke<void>("replay_save_now");
}

export async function replaySetAutostart(enabled: boolean): Promise<boolean> {
  return invoke<boolean>("replay_set_autostart", { enabled });
}

export async function replaySuspendHotkeys(suspend: boolean): Promise<void> {
  return invoke<void>("replay_suspend_hotkeys", { suspend });
}

export async function replayPollPressedKey(): Promise<PressedKeyInfo | null> {
  return invoke<PressedKeyInfo | null>("replay_poll_pressed_key");
}

export async function replayPickFolder(initial?: string): Promise<string | null> {
  return invoke<string | null>("replay_pick_folder", { initial: initial ?? null });
}

export async function replayOpenFolder(path?: string): Promise<void> {
  return invoke<void>("replay_open_folder", { path: path ?? null });
}

export async function replayRevealFile(path: string): Promise<void> {
  return invoke<void>("replay_reveal_file", { path });
}

export async function clipsScan(subfolder?: string | null): Promise<LibraryScan> {
  return invoke<LibraryScan>("clips_scan", { subfolder: subfolder ?? null });
}

export async function clipsInspect(path: string, waveBuckets = 0): Promise<ClipInspect> {
  return invoke<ClipInspect>("clips_inspect", { path, waveBuckets });
}

export async function clipsImportDialog(): Promise<string[]> {
  return invoke<string[]>("clips_import_dialog");
}

export async function clipsCreateFolder(name: string, moveFiles: string[] = []): Promise<string> {
  return invoke<string>("clips_create_folder", { name, moveFiles });
}

export async function clipsRenameFolder(
  fromPath: string,
  newName: string,
): Promise<[string, string][]> {
  return invoke<[string, string][]>("clips_rename_folder", { fromPath, newName });
}

export async function clipsMoveClips(
  paths: string[],
  targetDir: string,
): Promise<[string, string][]> {
  return invoke<[string, string][]>("clips_move_clips", { paths, targetDir });
}

export async function clipsDeleteItems(paths: string[]): Promise<void> {
  return invoke<void>("clips_delete_items", { paths });
}

export async function clipsDeleteFolder(folderPath: string): Promise<void> {
  return invoke<void>("clips_delete_folder", { folderPath });
}

export async function clipsPreviewExportPlan(req: ExportRequestDto): Promise<ExportPlanDto> {
  return invoke<ExportPlanDto>("clips_preview_export_plan", { req });
}

export async function clipsStartExport(req: ExportRequestDto): Promise<string> {
  return invoke<string>("clips_start_export", { req });
}

export async function clipsGetExportStatus(): Promise<ExportStatusDto> {
  return invoke<ExportStatusDto>("clips_get_export_status");
}

export async function clipsCancelExport(): Promise<void> {
  return invoke<void>("clips_cancel_export");
}

// --- Event Listeners ---

export async function onReplayStateChanged(cb: () => void): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return listen("replay:state-changed", () => cb());
}

export async function onReplayClipSaved(cb: (ev: ClipSavedEvent) => void): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return listen<ClipSavedEvent>("replay:clip-saved", (e) => cb(e.payload));
}

export async function onReplaySaveFailed(cb: (msg: string) => void): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return listen<string>("replay:save-failed", (e) => cb(e.payload));
}

export async function onReplayNavigate(
  cb: (route: "recorder" | "clips") => void,
): Promise<UnlistenFn> {
  if (!isTauriRuntime()) return () => {};
  return listen<"recorder" | "clips">("replay:navigate", (e) => cb(e.payload));
}

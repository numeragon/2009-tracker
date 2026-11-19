import { useCallback, useEffect, useState } from "react";
import {
  Check,
  ClipboardCopy,
  Crosshair,
  Loader2,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import type { CrosshairConfig, SavedCrosshair } from "../lib/crosshair";
import {
  createDefaultConfig,
  deleteCrosshairEntry,
  generateCrosshairCode,
  loadSavedCrosshairs,
  parseCrosshairCode,
  parseGameProfile,
  saveCrosshairEntry,
} from "../lib/crosshair";
import {
  fetchCrosshairFromClient,
  isTauriRuntime,
  loadRiotSession,
} from "../lib/localClientApi";
import type { Region } from "../types/valorant";
import { CrosshairPreview } from "./CrosshairPreview";

type RemoteState =
  | { status: "loading" }
  | { status: "ready"; config: CrosshairConfig; code: string }
  | { status: "error"; message: string };

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

function formatSavedAt(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes(),
  ).padStart(2, "0")}`;
}

export function CrosshairView({ defaultRegion }: { defaultRegion: Region }) {
  const [remote, setRemote] = useState<RemoteState>({ status: "loading" });
  const [currentName, setCurrentName] = useState("");
  const [saved, setSaved] = useState<SavedCrosshair[]>(() => loadSavedCrosshairs());
  const [importCode, setImportCode] = useState("");
  const [importConfig, setImportConfig] = useState<CrosshairConfig | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importName, setImportName] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setRemote({ status: "loading" });
    try {
      const result = await fetchCrosshairFromClient(defaultRegion, loadRiotSession());
      if (!result.ok || !result.profileData) {
        setRemote({
          status: "error",
          message: result.message ?? "クロスヘア設定を取得できませんでした。",
        });
        return;
      }
      const config = parseGameProfile(
        result.profileData,
        result.profileName || "現在のクロスヘア",
      );
      if (!config) {
        setRemote({
          status: "error",
          message:
            "クロスヘア設定の解析に失敗しました。ゲーム内でクロスヘアを保存し直してから再取得してください。",
        });
        return;
      }
      setCurrentName(config.name);
      setRemote({
        status: "ready",
        config,
        code: generateCrosshairCode(config),
      });
    } catch (err) {
      setRemote({
        status: "error",
        message:
          err instanceof Error
            ? `クロスヘア設定の取得に失敗しました: ${err.message}`
            : "クロスヘア設定の取得に失敗しました。",
      });
    }
  }, [defaultRegion]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  useEffect(() => {
    if (!copiedId) return;
    const id = setTimeout(() => setCopiedId(null), 2000);
    return () => clearTimeout(id);
  }, [copiedId]);

  const handleSaveCurrent = () => {
    if (remote.status !== "ready") return;
    const next = saveCrosshairEntry(remote.config, "game", currentName);
    setSaved(next);
    setToast("現在のクロスヘアを保存しました");
  };

  const handleImportChange = (value: string) => {
    setImportCode(value);
    setImportError(null);
    if (!value.trim()) {
      setImportConfig(null);
      setImportName("");
      return;
    }
    const parsed = parseCrosshairCode(value);
    if (!parsed) {
      setImportConfig(null);
      setImportError("コードの形式が正しくありません（例: 0;P;c;5;...）");
      return;
    }
    setImportConfig(parsed);
    setImportName(parsed.name || "インポートしたクロスヘア");
  };

  const handleSaveImport = () => {
    if (!importConfig) return;
    const next = saveCrosshairEntry(importConfig, "import", importName);
    setSaved(next);
    setToast("コードからクロスヘアを保存しました");
    setImportCode("");
    setImportConfig(null);
    setImportError(null);
    setImportName("");
  };

  const handleCopy = async (id: string, text: string) => {
    const ok = await copyText(text);
    if (ok) setCopiedId(id);
    else setToast("クリップボードへのコピーに失敗しました");
  };

  const handleDelete = (id: string) => {
    setSaved(deleteCrosshairEntry(id));
    setToast("保存したクロスヘアを削除しました");
  };

  return (
    <div className="max-w-5xl mx-auto py-8 px-6 space-y-6 vt-animate-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <Crosshair className="w-4 h-4 text-[#8f8f8f]" />
            <h1 className="text-xl font-semibold tracking-tight text-[#ededed]">
              クロスヘア保存
            </h1>
          </div>
          <p className="text-xs text-[#8f8f8f] mt-1.5">
            ゲーム内のクロスヘアを取得して保存・共有コードとしてコピーできます。ショップでRiotアカウントにログイン済みなら、ゲームを起動していなくても取得できます。保存した設定はこのPC内にのみ残ります。
          </p>
        </div>

        <button
          type="button"
          onClick={() => void refresh()}
          disabled={remote.status === "loading"}
          className="inline-flex items-center gap-1.5 h-9 px-4 text-xs font-medium rounded-[12px] bg-[#ededed] text-black hover:bg-white transition-colors duration-150 disabled:opacity-50 cursor-pointer self-start sm:self-center shrink-0"
        >
          {remote.status === "loading" ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RefreshCw className="w-3.5 h-3.5" />
          )}
          <span>クライアントから取得</span>
        </button>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Current crosshair */}
        <section className="vt-panel overflow-hidden">
          <div className="px-5 py-3.5 flex items-center justify-between vt-hairline-b bg-[#0a0a0a]">
            <h2 className="text-sm font-medium text-[#ededed]">現在のクロスヘア</h2>
            <span className="font-num text-[10px] text-[#5c5c5c] uppercase">
              from client
            </span>
          </div>

          <div className="p-5 space-y-4">
            {remote.status === "loading" && (
              <div className="h-52 rounded-[12px] border border-[rgba(255,255,255,0.09)] bg-black flex items-center justify-center">
                <Loader2 className="w-5 h-5 text-[#5c5c5c] animate-spin" />
              </div>
            )}

            {remote.status === "error" && (
              <div className="space-y-3">
                <div className="h-52 rounded-[12px] border border-dashed border-[rgba(255,255,255,0.14)] bg-black flex items-center justify-center">
                  <Crosshair className="w-8 h-8 text-[#262626]" />
                </div>
                <p className="text-xs text-[#8f8f8f] leading-relaxed">{remote.message}</p>
                {!isTauriRuntime() && (
                  <p className="text-[11px] text-[#5c5c5c]">
                    デスクトップアプリ（.exe）で起動すると、起動中のVALORANTから自動取得します。
                  </p>
                )}
              </div>
            )}

            {remote.status === "ready" && (
              <>
                <div className="rounded-[12px] border border-[rgba(255,255,255,0.09)] bg-black flex items-center justify-center py-4">
                  <CrosshairPreview
                    visual={remote.config.primary}
                    className="w-40 h-40 shrink-0"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[11px] text-[#5c5c5c]">保存名</label>
                  <input
                    value={currentName}
                    onChange={(event) => setCurrentName(event.target.value)}
                    maxLength={60}
                    className="w-full h-9 bg-black text-xs text-[#ededed] placeholder:text-[#5c5c5c] px-3 rounded-[10px] border border-[rgba(255,255,255,0.09)] focus:border-[rgba(255,255,255,0.28)] focus:outline-none transition-colors duration-150"
                    placeholder="例: メイン / タップ用"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-[#5c5c5c]">共有コード</span>
                    <button
                      type="button"
                      onClick={() => void handleCopy("current", remote.code)}
                      className="inline-flex items-center gap-1 text-[11px] text-[#8f8f8f] hover:text-[#ededed] transition-colors cursor-pointer"
                    >
                      {copiedId === "current" ? (
                        <>
                          <Check className="w-3 h-3" /> コピー済み
                        </>
                      ) : (
                        <>
                          <ClipboardCopy className="w-3 h-3" /> コピー
                        </>
                      )}
                    </button>
                  </div>
                  <code className="block max-h-20 overflow-y-auto break-all rounded-[10px] border border-[rgba(255,255,255,0.09)] bg-black px-3 py-2 font-num text-[11px] leading-relaxed text-[#8f8f8f]">
                    {remote.code}
                  </code>
                </div>

                <button
                  type="button"
                  onClick={handleSaveCurrent}
                  className="w-full inline-flex items-center justify-center gap-1.5 h-9 text-xs font-medium rounded-[10px] bg-[#ededed] text-black hover:bg-white transition-colors duration-150 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  このクロスヘアを保存
                </button>
              </>
            )}
          </div>
        </section>

        {/* Import */}
        <section className="vt-panel overflow-hidden">
          <div className="px-5 py-3.5 flex items-center justify-between vt-hairline-b bg-[#0a0a0a]">
            <h2 className="text-sm font-medium text-[#ededed]">コードから保存</h2>
            <span className="font-num text-[10px] text-[#5c5c5c] uppercase">import</span>
          </div>

          <div className="p-5 space-y-4">
            <textarea
              value={importCode}
              onChange={(event) => handleImportChange(event.target.value)}
              rows={5}
              spellCheck={false}
              className="w-full resize-none bg-black text-[11px] font-num text-[#ededed] placeholder:text-[#5c5c5c] px-3 py-2.5 rounded-[10px] border border-[rgba(255,255,255,0.09)] focus:border-[rgba(255,255,255,0.28)] focus:outline-none transition-colors duration-150"
              placeholder={'0;P;c;5;h;0;0l;4;0o;2;0a;1;0f;0;1b;0'}
            />

            {importError && (
              <p className="text-[11px] text-[var(--semantic-loss)]">{importError}</p>
            )}

            <div className="h-52 rounded-[12px] border border-[rgba(255,255,255,0.09)] bg-black flex items-center justify-center">
              {importConfig ? (
                <CrosshairPreview visual={importConfig.primary} className="w-40 h-40" />
              ) : (
                <div className="text-center space-y-1.5">
                  <Crosshair className="w-7 h-7 mx-auto text-[#262626]" />
                  <p className="text-[11px] text-[#5c5c5c]">
                    コードを貼り付けるとプレビューされます
                  </p>
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-[11px] text-[#5c5c5c]">保存名</label>
              <input
                value={importName}
                onChange={(event) => setImportName(event.target.value)}
                disabled={!importConfig}
                maxLength={60}
                className="w-full h-9 bg-black text-xs text-[#ededed] placeholder:text-[#5c5c5c] px-3 rounded-[10px] border border-[rgba(255,255,255,0.09)] focus:border-[rgba(255,255,255,0.28)] focus:outline-none transition-colors duration-150 disabled:opacity-40"
                placeholder="例: 配信用クロスヘア"
              />
            </div>

            <button
              type="button"
              onClick={handleSaveImport}
              disabled={!importConfig}
              className="w-full inline-flex items-center justify-center gap-1.5 h-9 text-xs font-medium rounded-[10px] bg-[#ededed] text-black hover:bg-white transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <Save className="w-3.5 h-3.5" />
              コードを保存
            </button>
          </div>
        </section>
      </div>

      {/* Saved crosshairs */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-[#ededed]">
            保存済みクロスヘア
            <span className="ml-2 font-num text-xs text-[#5c5c5c]">{saved.length}</span>
          </h2>
          {saved.length > 0 && (
            <span className="text-[11px] text-[#5c5c5c]">このPC内に保存</span>
          )}
        </div>

        {saved.length === 0 ? (
          <div className="vt-panel p-8 text-center">
            <p className="text-xs text-[#8f8f8f]">
              まだ保存されたクロスヘアはありません。
            </p>
            <p className="text-[11px] text-[#5c5c5c] mt-1">
              上のカードから現在の設定、または共有コードを保存できます。
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            {saved.map((item) => (
              <div
                key={item.id}
                className="vt-panel px-4 py-3 flex items-center gap-4 hover:bg-white/[0.02] transition-colors duration-150"
              >
                <div className="w-14 h-14 shrink-0 rounded-[10px] border border-[rgba(255,255,255,0.09)] bg-black flex items-center justify-center overflow-hidden">
                  <CrosshairPreview
                    visual={(item.config ?? createDefaultConfig()).primary}
                    className="w-12 h-12"
                  />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-[#ededed] truncate">{item.name}</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded border border-[rgba(255,255,255,0.12)] text-[#8f8f8f] shrink-0">
                      {item.source === "game" ? "ゲーム内" : "コード"}
                    </span>
                    <span className="font-num text-[10px] text-[#5c5c5c]">
                      {formatSavedAt(item.createdAt)}
                    </span>
                  </div>
                  <code className="block mt-1 font-num text-[10px] text-[#5c5c5c] truncate">
                    {item.code}
                  </code>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handleCopy(item.id, item.code)}
                    title="コードをコピー"
                    className="p-2 rounded-[8px] text-[#8f8f8f] hover:text-[#ededed] hover:bg-white/[0.06] transition-colors cursor-pointer"
                  >
                    {copiedId === item.id ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      <ClipboardCopy className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(item.id)}
                    title="削除"
                    className="p-2 rounded-[8px] text-[#5c5c5c] hover:text-[var(--semantic-loss)] hover:bg-white/[0.06] transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-[10px] bg-[#141414] border border-[rgba(255,255,255,0.14)] text-xs text-[#ededed] shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { Check, DownloadCloud, Eye, EyeOff, ExternalLink, KeyRound, Loader2, RotateCcw, Trash2 } from "lucide-react";
import type { AppSettings, Region } from "../types/valorant";
import { openExternalUrl } from "../lib/externalLink";
import { BUILTIN_API_KEY, clearApiCache, sanitizeApiKey } from "../lib/storage";
import { checkAndApplyUpdate, getCurrentAppVersion } from "../lib/updater";

const REGION_OPTIONS: Array<{ value: Region; label: string; sub: string }> = [
  { value: "ap", label: "AP", sub: "アジア太平洋（日本を含む）" },
  { value: "kr", label: "KR", sub: "韓国" },
  { value: "na", label: "NA", sub: "北米" },
  { value: "eu", label: "EU", sub: "ヨーロッパ" },
  { value: "latam", label: "LATAM", sub: "ラテンアメリカ" },
  { value: "br", label: "BR", sub: "ブラジル" },
];

interface SettingsViewProps {
  settings: AppSettings;
  onSaveSettings: (next: AppSettings) => Promise<void>;
}

export function SettingsView({ settings, onSaveSettings }: SettingsViewProps) {
  const [keyInput, setKeyInput] = useState(settings.apiKey);
  const [region, setRegion] = useState<Region>(settings.defaultRegion);
  const [showKey, setShowKey] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [appVersion, setAppVersion] = useState("0.1.0");
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);

  useEffect(() => {
    void getCurrentAppVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    setKeyInput(settings.apiKey);
    setRegion(settings.defaultRegion);
  }, [settings.apiKey, settings.defaultRegion]);

  const isUsingBuiltinKey = settings.apiKey === BUILTIN_API_KEY;

  const showNotice = (msg: string) => {
    setFeedback(msg);
    window.setTimeout(() => {
      setFeedback((prev) => (prev === msg ? null : prev));
    }, 3000);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleaned = sanitizeApiKey(keyInput) || BUILTIN_API_KEY;
    setKeyInput(cleaned);
    await onSaveSettings({
      apiKey: cleaned,
      defaultRegion: region,
    });
    setConfirmDelete(false);
    showNotice("設定を保存しました");
  };

  const handleResetBuiltinKey = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setKeyInput(BUILTIN_API_KEY);
    setConfirmDelete(false);
    await onSaveSettings({
      apiKey: BUILTIN_API_KEY,
      defaultRegion: region,
    });
    showNotice("組み込みのデフォルトAPIキーに戻しました");
  };

  const handleRegionChange = async (nextRegion: Region) => {
    setRegion(nextRegion);
    await onSaveSettings({
      apiKey: sanitizeApiKey(keyInput),
      defaultRegion: nextRegion,
    });
    showNotice(`デフォルトリージョンを ${nextRegion.toUpperCase()} に変更しました`);
  };

  const handleClearCache = () => {
    clearApiCache();
    showNotice("APIキャッシュをクリアしました");
  };

  return (
    <div className="max-w-2xl mx-auto py-8 px-6 vt-animate-in">
      <div className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight text-[#ededed]">設定</h1>
        <p className="text-sm text-[#8f8f8f] mt-1.5">
          APIキーとデフォルトリージョンを管理します。設定はお使いのPC内にのみ保存されます。
        </p>
      </div>

      {/* API Key Section */}
      <section className="vt-panel p-6 mb-6">
        <div className="flex items-start justify-between gap-4 pb-5 vt-hairline-b">
          <div>
            <div className="flex items-center gap-2.5">
              <KeyRound className="w-4 h-4 text-[#8f8f8f]" />
              <h2 className="text-sm font-medium text-[#ededed]">HenrikDev APIキー</h2>
              <span className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--semantic-win-border)] bg-[var(--semantic-win-bg)] text-[var(--semantic-win)]">
                {isUsingBuiltinKey ? "組み込みキー適用中" : "カスタムキー設定済み"}
              </span>
            </div>
            <p className="text-xs text-[#8f8f8f] mt-2 leading-relaxed">
              プロフィール検索と試合履歴の取得に使用します。ライブ画面のランク・K/D とリーダーボードは
              Riot のクライアント／ログインから直接取得するため、APIキーは不要です。キーはリクエスト時の{" "}
              <code className="font-num text-[#ededed]">Authorization</code>{" "}
              ヘッダー以外には送信されません。
            </p>
          </div>
        </div>

        <form onSubmit={handleSave} className="pt-5 space-y-4">
          <div>
            <label htmlFor="henrik-api-key" className="block text-xs text-[#8f8f8f] mb-2">
              APIキー
            </label>
            <div className="relative flex items-center">
              <input
                id="henrik-api-key"
                type={showKey ? "text" : "password"}
                value={keyInput}
                onChange={(e) => {
                  setKeyInput(e.target.value);
                  setConfirmDelete(false);
                }}
                placeholder="HDEV-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                autoComplete="off"
                spellCheck={false}
                className="w-full h-10 bg-black text-sm font-num text-[#ededed] placeholder:text-[#5c5c5c] pl-3.5 pr-10 rounded-[12px] border border-[rgba(255,255,255,0.09)] focus:border-[rgba(255,255,255,0.28)] focus:outline-none transition-colors duration-150"
              />
              <button
                type="button"
                onClick={() => setShowKey((v) => !v)}
                aria-label={showKey ? "APIキーを隠す" : "APIキーを表示"}
                className="absolute right-2.5 p-1.5 text-[#8f8f8f] hover:text-[#ededed] transition-colors"
              >
                {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={() => openExternalUrl("https://api.henrikdev.xyz/dashboard")}
              className="inline-flex items-center gap-1.5 text-xs text-[#8f8f8f] hover:text-[#ededed] transition-colors cursor-pointer"
            >
              <span>APIキーを取得する (api.henrikdev.xyz/dashboard)</span>
              <ExternalLink className="w-3.5 h-3.5" />
            </button>

            <div className="flex items-center gap-2.5">
              {!isUsingBuiltinKey && (
                <button
                  type="button"
                  onClick={handleResetBuiltinKey}
                  className={`inline-flex items-center gap-1.5 h-9 px-3.5 text-xs rounded-[12px] border transition-colors duration-150 cursor-pointer ${
                    confirmDelete
                      ? "border-[var(--semantic-loss-border)] bg-[var(--semantic-loss-bg)] text-[var(--semantic-loss)]"
                      : "border-[rgba(255,255,255,0.09)] text-[#8f8f8f] hover:text-[#ededed] hover:border-[rgba(255,255,255,0.18)]"
                  }`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>{confirmDelete ? "もう一度押して戻す" : "組み込みキーに戻す"}</span>
                </button>
              )}

              <button
                type="submit"
                className="inline-flex items-center gap-1.5 h-9 px-4 text-xs font-medium rounded-[12px] bg-[#ededed] text-black hover:bg-white transition-colors duration-150 cursor-pointer"
              >
                <Check className="w-3.5 h-3.5" />
                <span>保存する</span>
              </button>
            </div>
          </div>
        </form>
      </section>

      {/* Default Region Section */}
      <section className="vt-panel p-6 mb-6">
        <div className="pb-4 vt-hairline-b">
          <h2 className="text-sm font-medium text-[#ededed]">デフォルトリージョン</h2>
          <p className="text-xs text-[#8f8f8f] mt-1">
            プレイヤー検索時に使用するリージョンを指定します（日本サーバーは AP です）。
          </p>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 pt-4">
          {REGION_OPTIONS.map((opt) => {
            const active = region === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleRegionChange(opt.value)}
                className={`text-left p-3.5 rounded-[12px] border transition-colors duration-150 cursor-pointer ${
                  active
                    ? "bg-white/[0.06] border-white/30 text-[#ededed]"
                    : "bg-black/40 border-[rgba(255,255,255,0.09)] text-[#8f8f8f] hover:text-[#ededed] hover:border-[rgba(255,255,255,0.18)]"
                }`}
              >
                <div className="font-num text-sm font-semibold">{opt.label}</div>
                <div className="text-[11px] text-[#8f8f8f] mt-0.5 truncate">{opt.sub}</div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Cache Section */}
      <section className="vt-panel p-6 mb-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-sm font-medium text-[#ededed]">ローカルキャッシュ</h2>
            <p className="text-xs text-[#8f8f8f] mt-1">
              API呼び出し回数を抑えるため、取得した戦績は5分間キャッシュされます。
            </p>
          </div>
          <button
            type="button"
            onClick={handleClearCache}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs rounded-[12px] border border-[rgba(255,255,255,0.09)] text-[#8f8f8f] hover:text-[#ededed] hover:border-[rgba(255,255,255,0.18)] transition-colors duration-150 shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>キャッシュ消去</span>
          </button>
        </div>
      </section>

      {/* Auto Update Section */}
      <section className="vt-panel p-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-sm font-medium text-[#ededed]">自動アップデート</h2>
              <span className="font-num text-[11px] px-2 py-0.5 rounded-full border border-[rgba(255,255,255,0.09)] text-[#8f8f8f]">
                v{appVersion}
              </span>
            </div>
            <p className="text-xs text-[#8f8f8f] mt-1">
              起動時に GitHub（numeragon/2009-tracker）の新バージョンを自動検出し、自動で更新します。
            </p>
          </div>
          <button
            type="button"
            disabled={isCheckingUpdate}
            onClick={async () => {
              setIsCheckingUpdate(true);
              await checkAndApplyUpdate((st) => {
                if (st.phase === "up-to-date") {
                  showNotice("すでに最新バージョン（v" + appVersion + "）です");
                } else if (st.phase === "error" && st.message) {
                  showNotice("アップデート確認: " + st.message);
                }
              });
              setIsCheckingUpdate(false);
            }}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs rounded-[12px] border border-[rgba(255,255,255,0.09)] text-[#ededed] hover:border-[rgba(255,255,255,0.22)] transition-colors duration-150 shrink-0 cursor-pointer disabled:opacity-50"
          >
            {isCheckingUpdate ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <DownloadCloud className="w-3.5 h-3.5" />
            )}
            <span>アップデートを確認</span>
          </button>
        </div>
      </section>

      {feedback && (
        <div className="mt-4 px-4 py-2.5 rounded-[12px] border border-[rgba(255,255,255,0.09)] bg-[#0a0a0a] text-xs text-[#ededed] vt-animate-in">
          {feedback}
        </div>
      )}
    </div>
  );
}

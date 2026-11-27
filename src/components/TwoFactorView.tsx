import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  KeyRound,
  Loader2,
  LogIn,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  formatTotpCode,
  generateTotp,
  parseTotpInput,
  totpRemainingSeconds,
} from "../lib/totp";
import {
  addTotpAccount,
  loadTotpAccounts,
  removeTotpAccount,
  type TotpAccount,
} from "../lib/twoFactorStore";

interface Riot2faLoginResult {
  ok: boolean;
  message: string | null;
  warning: string | null;
  name: string | null;
  puuid: string | null;
  secret: string | null;
}

interface ImportedAccount {
  name: string;
  seed: string;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function TwoFactorView() {
  const [accounts, setAccounts] = useState<TotpAccount[]>(() => loadTotpAccounts());
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [now, setNow] = useState(() => Date.now());
  const [addOpen, setAddOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [secretInput, setSecretInput] = useState("");
  const [previewCode, setPreviewCode] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [loginConfirm, setLoginConfirm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"login" | "import" | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Recompute every second; setState only when a code actually changed.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const account of accounts) {
        const code = await generateTotp(account.secret, {
          digits: account.digits,
          period: account.period,
          algorithm: account.algorithm,
          timestampMs: now,
        });
        if (code) next[account.id] = code;
      }
      if (cancelled) return;
      setCodes((prev) => {
        const keys = Object.keys(next);
        const changed =
          keys.length !== Object.keys(prev).length ||
          keys.some((key) => prev[key] !== next[key]);
        return changed ? next : prev;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [accounts, now]);

  // Preview the pasted secret as the user types.
  useEffect(() => {
    let cancelled = false;
    const parsed = parseTotpInput(secretInput);
    if (!parsed) {
      setPreviewCode(null);
      return;
    }
    void generateTotp(parsed.secret, {
      digits: parsed.digits,
      period: parsed.period,
      algorithm: parsed.algorithm,
    }).then((code) => {
      if (!cancelled) setPreviewCode(code);
    });
    return () => {
      cancelled = true;
    };
  }, [secretInput]);

  const refresh = useCallback(() => setAccounts(loadTotpAccounts()), []);

  const handleAdd = useCallback(() => {
    const parsed = parseTotpInput(secretInput);
    if (!parsed) {
      setAddError("シークレットの形式が正しくありません（Base32 または otpauth:// を貼り付けてください）。");
      return;
    }
    addTotpAccount({
      label: label.trim() || parsed.account || parsed.issuer || "Riotアカウント",
      secret: parsed.secret,
      issuer: parsed.issuer,
      account: parsed.account,
      algorithm: parsed.algorithm,
      digits: parsed.digits,
      period: parsed.period,
    });
    refresh();
    setAddOpen(false);
    setLabel("");
    setSecretInput("");
    setPreviewCode(null);
    setAddError(null);
    setNotice("アカウントを追加しました。");
    setWarning(null);
  }, [label, refresh, secretInput]);

  const handleImport = useCallback(async () => {
    if (!isTauriRuntime()) {
      setError("インポートはデスクトップアプリ（.exe）でのみ利用できます。");
      return;
    }
    setBusy("import");
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      const imported = await invoke<ImportedAccount[]>("read_riot2fa_accounts");
      if (imported.length === 0) {
        setError("Riot2FA のアカウントが見つかりませんでした。");
        return;
      }
      let added = 0;
      for (const item of imported) {
        const parsed = parseTotpInput(item.seed);
        if (!parsed) continue;
        addTotpAccount({
          label: item.name,
          secret: parsed.secret,
          algorithm: parsed.algorithm,
          digits: parsed.digits,
          period: parsed.period,
        });
        added += 1;
      }
      refresh();
      setNotice(`${added}件のアカウントをRiot2FAからインポートしました。`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleLogin = useCallback(async () => {
    if (!isTauriRuntime()) {
      setError("Riotログインはデスクトップアプリ（.exe）でのみ利用できます。");
      return;
    }
    setLoginConfirm(false);
    setBusy("login");
    setError(null);
    setNotice(null);
    setWarning(null);
    try {
      const result = await invoke<Riot2faLoginResult>("riot_2fa_login");
      if (!result.ok || !result.secret) {
        setError(result.message ?? "認証コードの取得に失敗しました。");
        return;
      }
      addTotpAccount({
        label: result.name ?? "Riotアカウント",
        secret: result.secret,
      });
      refresh();
      setNotice("Riot Mobile 2FA を有効化し、コードを追加しました。");
      if (result.warning) setWarning(result.warning);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const handleCopy = useCallback(async (accountId: string, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(accountId);
      window.setTimeout(() => setCopiedId((current) => (current === accountId ? null : current)), 1500);
    } catch {
      // Ignore clipboard errors
    }
  }, []);

  const handleDelete = useCallback(
    (accountId: string) => {
      setAccounts(removeTotpAccount(accountId));
      setPendingDelete(null);
    },
    [],
  );

  const empty = accounts.length === 0;
  const addDisabled = !parseTotpInput(secretInput);

  const rows = useMemo(
    () =>
      accounts.map((account) => ({
        account,
        code: codes[account.id] ?? null,
        remaining: totpRemainingSeconds(account.period, now),
      })),
    [accounts, codes, now],
  );

  return (
    <div className="max-w-3xl mx-auto py-8 px-6 space-y-6 vt-animate-in">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <KeyRound className="w-4 h-4 text-[#8f8f8f] shrink-0" />
            <h1 className="text-xl font-semibold tracking-tight text-[#ededed] whitespace-nowrap">
              2FA 認証コード
            </h1>
          </div>
          <p className="text-xs text-[#8f8f8f] mt-1.5">
            Riot Mobile の一時認証コードを表示します。コードはマウスを重ねると見えます。
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs rounded-[12px] border border-[rgba(255,255,255,0.09)] bg-[#0a0a0a] text-[#8f8f8f] hover:text-[#ededed] hover:border-white/20 transition-colors duration-150 disabled:opacity-50 cursor-pointer whitespace-nowrap"
          >
            {busy === "import" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Download className="w-3.5 h-3.5" />
            )}
            <span>インポート</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setAddOpen(false);
              setLoginConfirm((open) => !open);
            }}
            disabled={busy !== null}
            className={`inline-flex items-center gap-1.5 h-9 px-3.5 text-xs rounded-[12px] border bg-[#0a0a0a] transition-colors duration-150 disabled:opacity-50 cursor-pointer whitespace-nowrap ${
              loginConfirm
                ? "border-white/25 text-[#ededed]"
                : "border-[rgba(255,255,255,0.09)] text-[#8f8f8f] hover:text-[#ededed] hover:border-white/20"
            }`}
          >
            {busy === "login" ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <LogIn className="w-3.5 h-3.5" />
            )}
            <span>ログインから取得</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setLoginConfirm(false);
              setAddOpen((open) => !open);
            }}
            className="inline-flex items-center gap-1.5 h-9 px-4 text-xs font-medium rounded-[12px] bg-[#ededed] text-black hover:bg-white transition-colors duration-150 cursor-pointer whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            手動で追加
          </button>
        </div>
      </div>

      {notice && (
        <div className="flex items-center gap-2 text-xs text-[var(--semantic-win)]">
          <Check className="w-3.5 h-3.5" />
          {notice}
        </div>
      )}
      {warning && (
        <div className="flex items-start gap-2 text-xs text-[#8f8f8f] leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="flex-1">{warning}</span>
          <button
            type="button"
            onClick={() => setWarning(null)}
            className="text-[#5c5c5c] hover:text-[#ededed] cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2 text-xs text-[var(--semantic-loss)] leading-relaxed">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-[#5c5c5c] hover:text-[#ededed] cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {loginConfirm && (
        <section className="vt-panel p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-[#ededed]">
              Riotアカウントにログインして取得
            </h2>
            <button
              type="button"
              onClick={() => setLoginConfirm(false)}
              className="text-[#5c5c5c] hover:text-[#ededed] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <ul className="space-y-1.5 text-[11px] text-[#8f8f8f] leading-relaxed">
            <li>・Riotアカウントにログインし、Riot Mobile 2FA を有効化してシークレットを取得します。</li>
            <li>・メール認証（2FA）が有効なアカウントでのみ動作します。</li>
            <li>・すでに Riot Mobile 2FA が有効なアカウントでは取得できません。</li>
            <li>・ログインは新しいウィンドウで開き、終了後にセッションは破棄されます。</li>
          </ul>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleLogin()}
              className="inline-flex items-center gap-1.5 h-9 px-4 text-xs font-medium rounded-[12px] bg-[#ededed] text-black hover:bg-white transition-colors duration-150 cursor-pointer"
            >
              <LogIn className="w-3.5 h-3.5" />
              続行する
            </button>
            <button
              type="button"
              onClick={() => setLoginConfirm(false)}
              className="h-9 px-4 text-xs rounded-[12px] border border-[rgba(255,255,255,0.09)] text-[#8f8f8f] hover:text-[#ededed] hover:border-white/20 transition-colors duration-150 cursor-pointer"
            >
              キャンセル
            </button>
          </div>
        </section>
      )}

      {addOpen && (
        <section className="vt-panel p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-[#ededed]">アカウントを追加</h2>
            <button
              type="button"
              onClick={() => {
                setAddOpen(false);
                setAddError(null);
              }}
              className="text-[#5c5c5c] hover:text-[#ededed] cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <label htmlFor="totp-label" className="block text-xs text-[#8f8f8f] mb-1.5">
                表示名（任意）
              </label>
              <input
                id="totp-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="メインアカウント"
                className="w-full h-9 px-3 text-xs rounded-[10px] border border-[rgba(255,255,255,0.09)] bg-black text-[#ededed] placeholder:text-[#5c5c5c] outline-none focus:border-white/25"
              />
            </div>
            <div>
              <label htmlFor="totp-secret" className="block text-xs text-[#8f8f8f] mb-1.5">
                シークレット（Base32 または otpauth://）
              </label>
              <input
                id="totp-secret"
                value={secretInput}
                onChange={(event) => {
                  setSecretInput(event.target.value);
                  setAddError(null);
                }}
                placeholder="JBSWY3DPEHPK3PXP… / otpauth://totp/..."
                spellCheck={false}
                className="w-full h-9 px-3 font-num text-xs rounded-[10px] border border-[rgba(255,255,255,0.09)] bg-black text-[#ededed] placeholder:text-[#5c5c5c] outline-none focus:border-white/25"
              />
              <p className="text-[10px] text-[#5c5c5c] mt-1.5">
                Riotの2FAメールやQRコードのシークレットを貼り付けます。
              </p>
            </div>
          </div>

          {previewCode && (
            <div className="flex items-center gap-2 text-xs text-[#8f8f8f]">
              <ShieldCheck className="w-3.5 h-3.5" />
              プレビュー:
              <span className="font-num text-sm text-[#ededed] tracking-[0.15em]">
                {formatTotpCode(previewCode)}
              </span>
            </div>
          )}
          {addError && (
            <p className="text-[11px] text-[var(--semantic-loss)]">{addError}</p>
          )}

          <button
            type="button"
            onClick={handleAdd}
            disabled={addDisabled}
            className="inline-flex items-center gap-1.5 h-9 px-4 text-xs font-medium rounded-[12px] bg-[#ededed] text-black hover:bg-white transition-colors duration-150 disabled:opacity-40 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            追加する
          </button>
        </section>
      )}

      {empty ? (
        <section className="vt-panel p-8 text-center">
          <KeyRound className="w-8 h-8 text-[#262626] mx-auto" />
          <p className="text-sm text-[#8f8f8f] mt-3">
            まだアカウントが登録されていません。
          </p>
          <p className="text-xs text-[#5c5c5c] mt-1.5 leading-relaxed">
            「Riotログインから取得」または「手動で追加」でシークレットを登録すると、
            30秒ごとに更新される6桁のコードを表示できます。
          </p>
        </section>
      ) : (
        <div className="space-y-3">
          {rows.map(({ account, code, remaining }) => {
            const period = account.period;
            const fraction = Math.max(0, Math.min(1, remaining / period));
            const isPendingDelete = pendingDelete === account.id;
            return (
              <section
                key={account.id}
                className="group vt-panel relative overflow-hidden p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-[0.16em] text-[#5c5c5c] truncate">
                      {account.issuer || "Riot Games"}
                    </p>
                    <p className="text-sm text-[#ededed] truncate mt-0.5">
                      {account.label}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      title="コードをコピー"
                      onClick={() => code && void handleCopy(account.id, code)}
                      disabled={!code}
                      className="p-1.5 rounded-[8px] text-[#5c5c5c] hover:text-[#ededed] hover:bg-white/[0.04] transition-colors duration-150 disabled:opacity-40 cursor-pointer"
                    >
                      {copiedId === account.id ? (
                        <Check className="w-4 h-4 text-[var(--semantic-win)]" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                    {isPendingDelete ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => handleDelete(account.id)}
                          className="h-7 px-2 text-[10px] rounded-[8px] border border-[var(--semantic-loss-border)] text-[var(--semantic-loss)] hover:bg-[var(--semantic-loss-bg)] cursor-pointer"
                        >
                          削除
                        </button>
                        <button
                          type="button"
                          onClick={() => setPendingDelete(null)}
                          className="h-7 px-2 text-[10px] rounded-[8px] border border-[rgba(255,255,255,0.09)] text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
                        >
                          戻す
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        title="アカウントを削除"
                        onClick={() => setPendingDelete(account.id)}
                        className="p-1.5 rounded-[8px] text-[#5c5c5c] hover:text-[#ededed] hover:bg-white/[0.04] transition-colors duration-150 cursor-pointer"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                </div>

                <div className="mt-4 flex items-end justify-between gap-4">
                  <div>
                    <div className="relative inline-block">
                      <div
                        className={`font-num text-[30px] leading-none tracking-[0.22em] text-[#ededed] select-none ${
                          code ? "group-hover:select-text" : "opacity-40"
                        }`}
                      >
                        {code ? formatTotpCode(code) : "--- ---"}
                      </div>
                      {code && <div className="vt-frost" aria-hidden="true" />}
                    </div>
                    <p className="mt-2 text-[10px] text-[#5c5c5c] group-hover:text-[#8f8f8f] transition-colors">
                      マウスを重ねると表示
                    </p>
                  </div>

                  <div className="text-right">
                    <p className="font-num text-sm text-[#8f8f8f]">{remaining}s</p>
                    <p className="text-[10px] text-[#5c5c5c]">{period}秒で更新</p>
                  </div>
                </div>

                <div className="mt-3 h-[3px] rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className="h-full bg-[#ededed] transition-[width] duration-1000 ease-linear"
                    style={{ width: `${fraction * 100}%` }}
                  />
                </div>
              </section>
            );
          })}
        </div>
      )}

      <section className="vt-panel p-4">
        <div className="flex items-start gap-2.5">
          <AlertTriangle className="w-4 h-4 text-[#8f8f8f] mt-0.5 shrink-0" />
          <p className="text-[11px] text-[#5c5c5c] leading-relaxed">
            シークレットはこのPC内（localStorage）にのみ保存されます。第三者と共有したり、
            配信・スクリーンショットに映さないよう注意してください。コードは30秒ごとに更新されます。
          </p>
        </div>
      </section>
    </div>
  );
}

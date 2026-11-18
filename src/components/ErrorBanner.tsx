import { AlertCircle, KeyRound, RefreshCw, UserX } from "lucide-react";
import type { ApiClientError } from "../lib/errors";

interface ErrorBannerProps {
  error: ApiClientError;
  onRetry?: () => void;
  onOpenSettings?: () => void;
}

export function ErrorBanner({ error, onRetry, onOpenSettings }: ErrorBannerProps) {
  const isAuth = error.kind === "MISSING_API_KEY" || error.kind === "UNAUTHORIZED";
  const isNotFound = error.kind === "NOT_FOUND";

  return (
    <div className="vt-panel p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 vt-animate-in">
      <div className="flex items-start gap-3.5">
        <div className="w-8 h-8 rounded-[10px] border border-[rgba(255,255,255,0.09)] bg-black flex items-center justify-center shrink-0 mt-0.5">
          {isNotFound ? (
            <UserX className="w-4 h-4 text-[#8f8f8f]" />
          ) : isAuth ? (
            <KeyRound className="w-4 h-4 text-[#8f8f8f]" />
          ) : (
            <AlertCircle className="w-4 h-4 text-[#8f8f8f]" />
          )}
        </div>
        <div>
          <p className="text-sm font-medium text-[#ededed]">{error.message}</p>
          {error.kind === "RATE_LIMIT" && (
            <p className="text-xs text-[#8f8f8f] mt-1">
              短時間にリクエストが集中しています。数十秒ほど待ってから再試行してください。
            </p>
          )}
          {isNotFound && (
            <p className="text-xs text-[#8f8f8f] mt-1">
              Riot ID（名前#タグ）とリージョン設定が正しいかご確認ください。
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
        {isAuth && onOpenSettings && (
          <button
            type="button"
            onClick={onOpenSettings}
            className="inline-flex items-center gap-1.5 h-9 px-4 text-xs font-medium rounded-[12px] bg-[#ededed] text-black hover:bg-white transition-colors duration-150 cursor-pointer"
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>設定画面を開く</span>
          </button>
        )}

        {error.retryable && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 h-9 px-3.5 text-xs rounded-[12px] border border-[rgba(255,255,255,0.09)] text-[#ededed] hover:border-[rgba(255,255,255,0.22)] bg-black transition-colors duration-150 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>{error.kind === "RATE_LIMIT" ? "少し待って再試行" : "再試行"}</span>
          </button>
        )}
      </div>
    </div>
  );
}

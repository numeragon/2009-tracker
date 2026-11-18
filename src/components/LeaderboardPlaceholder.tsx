import { Trophy } from "lucide-react";

export function LeaderboardPlaceholder() {
  return (
    <div className="max-w-2xl mx-auto py-16 px-6 vt-animate-in">
      <div className="vt-panel p-8 text-center space-y-3">
        <div className="w-10 h-10 mx-auto rounded-[12px] border border-[rgba(255,255,255,0.09)] bg-black flex items-center justify-center">
          <Trophy className="w-4 h-4 text-[#8f8f8f]" />
        </div>
        <h1 className="text-base font-semibold text-[#ededed]">リーダーボード（Phase 2）</h1>
        <p className="text-xs text-[#8f8f8f] max-w-md mx-auto leading-relaxed">
          リージョン別の上位ランキング表示および順位検索機能は、Phase 1（MVP）の動作確認完了後に追加予定です。
        </p>
      </div>
    </div>
  );
}

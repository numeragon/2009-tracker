import { useEffect, useState } from "react";
import { ArrowRight, Loader2, Search } from "lucide-react";
import type { Region } from "../types/valorant";

const REGIONS: Region[] = ["ap", "kr", "na", "eu", "latam", "br"];

interface SearchBarProps {
  variant?: "header" | "hero";
  initialQuery?: string;
  region: Region;
  onRegionChange: (region: Region) => void;
  onSearch: (riotIdInput: string, region: Region) => void;
  isLoading?: boolean;
}

export function SearchBar({
  variant = "header",
  initialQuery = "",
  region,
  onRegionChange,
  onSearch,
  isLoading = false,
}: SearchBarProps) {
  const [value, setValue] = useState(initialQuery);

  useEffect(() => {
    if (initialQuery) {
      setValue(initialQuery);
    }
  }, [initialQuery]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || isLoading) return;
    onSearch(value, region);
  };

  const isHero = variant === "hero";

  return (
    <form
      onSubmit={handleSubmit}
      className={`w-full flex items-center gap-2 ${isHero ? "max-w-xl" : "max-w-lg"}`}
    >
      <div
        className={`flex-1 flex items-center bg-[#0a0a0a]/80 backdrop-blur-sm border border-[rgba(255,255,255,0.09)] focus-within:border-[rgba(255,255,255,0.25)] rounded-[12px] transition-colors duration-150 ${
          isHero ? "h-12 px-4" : "h-9 px-3"
        }`}
      >
        <Search className={`${isHero ? "w-4 h-4" : "w-3.5 h-3.5"} text-[#5c5c5c] shrink-0`} />
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Riot ID を検索（例: Player#JP1）"
          spellCheck={false}
          autoComplete="off"
          className={`w-full bg-transparent text-[#ededed] placeholder:text-[#5c5c5c] focus:outline-none ${
            isHero ? "text-sm pl-3" : "text-xs pl-2.5"
          }`}
        />

        <div className="h-4 w-[1px] bg-[rgba(255,255,255,0.09)] mx-2 shrink-0" />

        <select
          aria-label="検索リージョン"
          value={region}
          onChange={(e) => onRegionChange(e.target.value as Region)}
          className="bg-transparent font-num text-xs text-[#8f8f8f] hover:text-[#ededed] focus:outline-none cursor-pointer uppercase pr-1"
        >
          {REGIONS.map((r) => (
            <option key={r} value={r} className="bg-[#0a0a0a] text-[#ededed]">
              {r.toUpperCase()}
            </option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        disabled={isLoading || !value.trim()}
        className={`inline-flex items-center justify-center gap-1.5 rounded-[12px] font-medium transition-colors duration-150 shrink-0 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
          isHero
            ? "h-12 px-5 text-xs bg-[#ededed] text-black hover:bg-white"
            : "h-9 px-3.5 text-xs border border-[rgba(255,255,255,0.09)] bg-[#0a0a0a] text-[#ededed] hover:border-[rgba(255,255,255,0.22)]"
        }`}
      >
        {isLoading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <>
            <span>検索</span>
            {isHero && <ArrowRight className="w-3.5 h-3.5" />}
          </>
        )}
      </button>
    </form>
  );
}

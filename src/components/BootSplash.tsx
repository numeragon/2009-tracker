import { useEffect, useRef, useState } from "react";
import { WindowControls, handleTitlebarMouseDown } from "./WindowControls";

interface BootSplashProps {
  ready: boolean;
  encoderName?: string | null;
  onComplete: () => void;
}

const BAR_WIDTH = 32;

export function BootSplash({ ready, encoderName, onComplete }: BootSplashProps) {
  const [progress, setProgress] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [fading, setFading] = useState(false);

  const readyRef = useRef(ready);
  const doneRef = useRef(false);

  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  const finish = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setProgress(100);
    setFading(true);
    window.setTimeout(() => {
      onComplete();
    }, 160);
  };

  useEffect(() => {
    const start = performance.now();
    const minMs = 1150;
    let raf = 0;

    const tick = (now: number) => {
      if (doneRef.current) return;
      const dt = now - start;
      setElapsedMs(dt);

      const raw = Math.min(1, dt / minMs);
      const canComplete = readyRef.current || dt > 2600;
      const cap = canComplete ? 100 : 92;
      const next = Math.min(cap, raw * 100);
      setProgress(next);

      if (next >= 100 && canComplete) {
        finish();
        return;
      }
      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filledCount = Math.round((progress / 100) * BAR_WIDTH);
  const asciiBar =
    "█".repeat(Math.max(0, Math.min(BAR_WIDTH, filledCount))) +
    "░".repeat(Math.max(0, BAR_WIDTH - filledCount));

  const lines = [
    {
      done: progress >= 18,
      active: progress < 18,
      module: "local.store",
      detail: "loading user settings, favorites & cache",
    },
    {
      done: progress >= 48,
      active: progress >= 18 && progress < 48,
      module: "valorant.assets",
      detail: "indexing agents, maps & competitive tier icons",
    },
    {
      done: progress >= 78,
      active: progress >= 48 && progress < 78,
      module: "replay.d3d11",
      detail: encoderName
        ? `gpu encoder bound (${encoderName})`
        : "initializing dxgi duplication & wasapi audio",
    },
    {
      done: progress >= 98,
      active: progress >= 78 && progress < 98,
      module: "henrik.client",
      detail: "ready for stats, live match & leaderboard",
    },
  ];

  return (
    <div
      onClick={() => {
        if (readyRef.current) finish();
      }}
      className={`fixed inset-0 z-50 bg-[#000000] text-[#ededed] flex flex-col justify-between ring-1 ring-inset ring-white/[0.08] transition-opacity duration-150 ${
        fading ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
    >
      {/* Pure-Black Draggable Header */}
      <div
        data-tauri-drag-region
        onMouseDown={handleTitlebarMouseDown}
        onClick={(e) => e.stopPropagation()}
        className="h-14 pl-6 pr-0 flex items-center justify-between shrink-0"
      >
        <span className="font-num text-xs text-[#5c5c5c] pointer-events-none">
          #2009 tracker — terminal boot
        </span>
        <WindowControls />
      </div>

      {/* Minimalist CLI Output Block */}
      <div className="flex-1 flex items-center justify-center px-6 pb-10">
        <div className="w-full max-w-xl font-num text-xs leading-relaxed space-y-4">
          {/* Header */}
          <div className="space-y-1">
            <div className="text-[#ededed]">
              <span className="text-[#8f8f8f]">$</span> ./2009-tracker --init{" "}
              <span className="text-[#5c5c5c]">v0.5.0 (windows-x86_64)</span>
            </div>
            <div className="text-[#5c5c5c] select-none">
              ------------------------------------------------------------
            </div>
          </div>

          {/* Sequential Log Lines */}
          <div className="space-y-1.5">
            {lines.map((line) => {
              const visible = line.done || line.active;
              if (!visible) {
                return (
                  <div key={line.module} className="text-[#262626]">
                    [ .. ] {line.module.padEnd(16, " ")} waiting
                  </div>
                );
              }
              return (
                <div key={line.module} className="flex items-baseline gap-2.5">
                  <span className={line.done ? "text-[#ededed]" : "text-[#8f8f8f]"}>
                    {line.done ? "[ OK ]" : "[ .. ]"}
                  </span>
                  <span className="text-[#ededed] w-36 shrink-0">{line.module}</span>
                  <span className="text-[#8f8f8f] truncate">{line.detail}</span>
                </div>
              );
            })}
          </div>

          {/* ASCII Progress Bar */}
          <div className="pt-2 space-y-1.5">
            <div className="flex items-center justify-between text-[11px] text-[#8f8f8f]">
              <span>status: {progress >= 100 ? "ready" : "initializing"}</span>
              <span>{(elapsedMs / 1000).toFixed(2)}s</span>
            </div>
            <div className="text-[#ededed] tracking-tight flex items-center gap-2">
              <span className="text-[#5c5c5c]">[</span>
              <span className="tracking-[-0.04em]">{asciiBar}</span>
              <span className="text-[#5c5c5c]">]</span>
              <span className="w-10 text-right font-semibold">
                {Math.round(progress).toString().padStart(3, " ")}%
              </span>
              <span className="inline-block w-1.5 h-3.5 bg-[#ededed] animate-pulse" />
            </div>
          </div>
        </div>
      </div>

      <div className="h-8 px-6 flex items-center justify-between font-num text-[11px] text-[#5c5c5c]">
        <span>ARCH: X86_64_MSVC</span>
        <span>{ready ? "CLICK TO SKIP" : "LOADING..."}</span>
      </div>
    </div>
  );
}

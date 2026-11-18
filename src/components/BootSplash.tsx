import { useEffect, useRef, useState } from "react";
import { WindowControls, handleTitlebarMouseDown } from "./WindowControls";

interface BootSplashProps {
  ready: boolean;
  encoderName?: string | null;
  onComplete: () => void;
}

const SCRAMBLE_CHARS = "0123456789ABCDEF#/_+*<>[]";

const BOOT_STEPS = [
  { at: 12, code: "LOCAL_STORE", label: "ローカル設定・キャッシュをマウント中" },
  { at: 38, code: "VAL_ASSETS", label: "エージェント・マップ・ランク素材を同期中" },
  { at: 68, code: "DXGI_GPU_MFT", label: "100% GPU インスタントリプレイエンジン初期化中" },
  { at: 92, code: "HENRIK_NET", label: "戦績・ライブマッチ・リーダーボード接続完了" },
  { at: 100, code: "SYSTEM_READY", label: "ALL SYSTEMS ONLINE — #2009 TRACKER" },
];

export function BootSplash({ ready, encoderName, onComplete }: BootSplashProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [exiting, setExiting] = useState(false);
  const [decodedTitle, setDecodedTitle] = useState("#####");
  const [decodedSub, setDecodedSub] = useState(".......");
  const [hexStream, setHexStream] = useState("0x0000 · INIT");

  const progressRef = useRef(0);
  const readyRef = useRef(ready);
  const exitingRef = useRef(false);

  useEffect(() => {
    readyRef.current = ready;
  }, [ready]);

  const triggerExit = () => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    progressRef.current = 100;
    setProgress(100);
    setDecodedTitle("#2009");
    setDecodedSub("TRACKER");
    setExiting(true);
    window.setTimeout(() => {
      onComplete();
    }, 520);
  };

  // Master progress & cryptographic text decode animation loop
  useEffect(() => {
    const startTime = performance.now();
    const minDurationMs = 2350;
    let raf = 0;

    const targetMain = "#2009";
    const targetSub = "TRACKER";

    const tick = (now: number) => {
      if (exitingRef.current) return;
      const elapsed = now - startTime;
      // Ease out cubic curve up to 94%, then finish to 100% once `readyRef.current` (or max 3.4s fallback)
      const rawT = Math.min(1, elapsed / minDurationMs);
      const eased = 1 - Math.pow(1 - rawT, 2.6);
      const canFinish = readyRef.current || elapsed > 3400;
      const cap = canFinish ? 100 : 94;
      const nextProg = Math.min(cap, eased * 100);

      progressRef.current = nextProg;
      setProgress(nextProg);

      // Scramble-decode "#2009" (locks in between 12% and 62%)
      const mainLocked = Math.floor(((nextProg - 10) / 52) * targetMain.length);
      let mainStr = "";
      for (let i = 0; i < targetMain.length; i++) {
        if (i < mainLocked || nextProg >= 65) {
          mainStr += targetMain[i];
        } else {
          const rnd =
            SCRAMBLE_CHARS[
              Math.floor((now * 0.045 + i * 7) % SCRAMBLE_CHARS.length)
            ];
          mainStr += rnd;
        }
      }
      setDecodedTitle(mainStr);

      // Scramble-decode "TRACKER" (locks in between 32% and 84%)
      const subLocked = Math.floor(((nextProg - 30) / 54) * targetSub.length);
      let subStr = "";
      for (let i = 0; i < targetSub.length; i++) {
        if (i < subLocked || nextProg >= 85) {
          subStr += targetSub[i];
        } else {
          const rnd =
            SCRAMBLE_CHARS[
              Math.floor((now * 0.038 + i * 11) % SCRAMBLE_CHARS.length)
            ];
          subStr += rnd;
        }
      }
      setDecodedSub(subStr);

      // Rolling hex telemetry string
      const addr = Math.floor((now * 13) % 0xffff)
        .toString(16)
        .toUpperCase()
        .padStart(4, "0");
      setHexStream(`0x${addr} · MEM_OK`);

      if (nextProg >= 99.9 && canFinish) {
        triggerExit();
        return;
      }

      raf = window.requestAnimationFrame(tick);
    };

    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 3D Orbital Vortex + HUD Rings + Shockwave Canvas Animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = 1;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize, { passive: true });

    const mouse = { x: 0, y: 0, sx: 0, sy: 0 };
    const onMove = (e: PointerEvent) => {
      if (width <= 0 || height <= 0) return;
      mouse.x = (e.clientX / width) * 2 - 1;
      mouse.y = (e.clientY / height) * 2 - 1;
    };
    window.addEventListener("pointermove", onMove, { passive: true });

    // 3D Star/Vortex particles
    interface Particle {
      angle: number;
      radius: number;
      z: number;
      speedZ: number;
      spin: number;
      size: number;
      bright: number;
    }

    const PARTICLE_COUNT = 520;
    const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => ({
      angle: Math.random() * Math.PI * 2,
      radius: 55 + Math.pow(Math.random(), 0.75) * 680,
      z: Math.random() * 1400 + 60,
      speedZ: 340 + Math.random() * 520,
      spin: (Math.random() - 0.5) * 0.9,
      size: 0.7 + Math.random() * 1.6,
      bright: 0.25 + Math.random() * 0.75,
    }));

    // Expanding shockwaves triggered at progress thresholds
    const pulses: Array<{ r: number; alpha: number; speed: number }> = [
      { r: 20, alpha: 0.65, speed: 520 },
    ];
    let lastMilestone = 0;

    let rafId = 0;
    let lastTime = performance.now() * 0.001;
    let totalTime = 0;

    const render = () => {
      rafId = window.requestAnimationFrame(render);
      const now = performance.now() * 0.001;
      const dt = Math.min(0.05, Math.max(0.001, now - lastTime));
      lastTime = now;
      totalTime += dt;

      const prog = progressRef.current;
      const warpMultiplier = exitingRef.current
        ? 6.8
        : 1 + (prog / 100) * 1.65;

      // Spawn milestone shockwaves at 30%, 65%, 95%, and exit
      const milestone =
        exitingRef.current ? 4 : prog >= 90 ? 3 : prog >= 60 ? 2 : prog >= 28 ? 1 : 0;
      if (milestone > lastMilestone) {
        lastMilestone = milestone;
        pulses.push({
          r: 70,
          alpha: milestone === 4 ? 0.9 : 0.5,
          speed: milestone === 4 ? 980 : 620,
        });
      }

      mouse.sx += (mouse.x - mouse.sx) * (1 - Math.exp(-dt * 6));
      mouse.sy += (mouse.y - mouse.sy) * (1 - Math.exp(-dt * 6));

      // Pure black clear with subtle motion trail feel
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, width, height);

      const cx = width * 0.5 + mouse.sx * 24;
      const cy = height * 0.47 + mouse.sy * 18;
      const fov = 560;

      // 1. Subtle 3D Perspective Horizon Grid Lines (top & bottom cyber planes)
      ctx.strokeStyle = "rgba(255, 255, 255, 0.035)";
      ctx.lineWidth = 1;
      for (let i = -8; i <= 8; i++) {
        const xOff = i * 95;
        ctx.beginPath();
        ctx.moveTo(cx + xOff * 0.18, cy + 120);
        ctx.lineTo(cx + xOff * 1.9, height + 20);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(cx + xOff * 0.18, cy - 120);
        ctx.lineTo(cx + xOff * 1.9, -20);
        ctx.stroke();
      }

      // 2. 3D Warp Vortex Particles with radial light streaks
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        const prevZ = p.z;
        p.z -= p.speedZ * warpMultiplier * dt;
        p.angle += p.spin * dt * (0.6 + (1400 - p.z) * 0.0008);

        if (p.z <= 35) {
          p.z = 1400;
          p.angle = Math.random() * Math.PI * 2;
          p.radius = 55 + Math.pow(Math.random(), 0.75) * 680;
          continue;
        }

        const wx = Math.cos(p.angle) * p.radius;
        const wy = Math.sin(p.angle) * p.radius * 0.72;

        const scale = fov / p.z;
        const sx = cx + wx * scale;
        const sy = cy + wy * scale;

        if (sx < -40 || sx > width + 40 || sy < -40 || sy > height + 40) continue;

        const prevScale = fov / Math.min(1450, prevZ + p.speedZ * warpMultiplier * 0.022);
        const px = cx + wx * prevScale;
        const py = cy + wy * prevScale;

        const depthAlpha = Math.min(1, (1400 - p.z) / 900) * p.bright;
        const alpha = Math.min(0.92, depthAlpha * (0.35 + (prog / 100) * 0.55));

        ctx.strokeStyle = `rgba(237, 237, 237, ${(alpha * 0.65).toFixed(3)})`;
        ctx.lineWidth = Math.max(0.7, p.size * scale * 0.55);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(sx, sy);
        ctx.stroke();

        ctx.fillStyle = `rgba(245, 245, 245, ${alpha.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(0.7, p.size * scale * 0.62), 0, Math.PI * 2);
        ctx.fill();
      }

      // 3. Precision Concentric HUD Orbital Rings around Center Emblem
      ctx.save();
      ctx.translate(cx, cy);

      // Outer dashed ring (slow clockwise)
      ctx.save();
      ctx.rotate(totalTime * 0.22);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.07)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 10, 18, 10]);
      ctx.beginPath();
      ctx.arc(0, 0, 235, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Degree tick ring (counter-clockwise)
      ctx.save();
      ctx.rotate(-totalTime * 0.35);
      const ticks = 72;
      for (let t = 0; t < ticks; t++) {
        const a = (t / ticks) * Math.PI * 2;
        const major = t % 6 === 0;
        const r0 = 186;
        const r1 = major ? 196 : 190;
        ctx.strokeStyle = major
          ? "rgba(237, 237, 237, 0.26)"
          : "rgba(255, 255, 255, 0.07)";
        ctx.lineWidth = major ? 1.2 : 0.8;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
        ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
        ctx.stroke();
      }
      ctx.restore();

      // Active progress arc ring (0..100%)
      const progAngle = (prog / 100) * Math.PI * 2;
      ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(0, 0, 156, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeStyle = "rgba(237, 237, 237, 0.82)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 156, -Math.PI * 0.5, -Math.PI * 0.5 + progAngle);
      ctx.stroke();

      // Leading bright node on progress arc
      const tipAngle = -Math.PI * 0.5 + progAngle;
      const tipX = Math.cos(tipAngle) * 156;
      const tipY = Math.sin(tipAngle) * 156;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(tipX, tipY, 3.2, 0, Math.PI * 2);
      ctx.fill();

      // Inner high-speed dual scanner arcs
      ctx.save();
      ctx.rotate(totalTime * 1.85);
      ctx.strokeStyle = "rgba(237, 237, 237, 0.28)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, 134, 0, Math.PI * 0.42);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 134, Math.PI, Math.PI * 1.42);
      ctx.stroke();
      ctx.restore();

      ctx.restore();

      // 4. Expanding Shockwaves
      for (let i = pulses.length - 1; i >= 0; i--) {
        const sw = pulses[i];
        sw.r += sw.speed * dt;
        sw.alpha -= dt * 0.72;
        if (sw.alpha <= 0.01) {
          pulses.splice(i, 1);
          continue;
        }
        ctx.strokeStyle = `rgba(237, 237, 237, ${sw.alpha.toFixed(3)})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.arc(cx, cy, sw.r, 0, Math.PI * 2);
        ctx.stroke();
      }

      // 5. Subtle vertical scanline sweep
      const scanY = ((totalTime * 260) % (height + 160)) - 80;
      const grad = ctx.createLinearGradient(0, scanY - 40, 0, scanY + 40);
      grad.addColorStop(0, "rgba(255, 255, 255, 0)");
      grad.addColorStop(0.5, "rgba(255, 255, 255, 0.035)");
      grad.addColorStop(1, "rgba(255, 255, 255, 0)");
      ctx.fillStyle = grad;
      ctx.fillRect(0, scanY - 40, width, 80);
    };

    rafId = window.requestAnimationFrame(render);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
    };
  }, []);

  const activeStep =
    [...BOOT_STEPS].reverse().find((s) => progress >= s.at) ?? BOOT_STEPS[0];

  return (
    <div
      onClick={() => {
        if (readyRef.current && progress > 35) triggerExit();
      }}
      className={`fixed inset-0 z-50 bg-[#000000] text-[#ededed] flex flex-col justify-between overflow-hidden ring-1 ring-inset ring-white/[0.08] transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        exiting ? "opacity-0 scale-[1.06] pointer-events-none" : "opacity-100 scale-100"
      }`}
    >
      {/* 3D Particle Vortex & HUD Canvas */}
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none"
      />

      {/* Top Pure-Black Draggable Header with Window Controls */}
      <div
        data-tauri-drag-region
        onMouseDown={handleTitlebarMouseDown}
        onClick={(e) => e.stopPropagation()}
        className="relative z-20 h-12 pl-6 pr-0 flex items-center justify-between text-[11px] font-num text-[#5c5c5c]"
      >
        <div className="flex items-center gap-3 pointer-events-none">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#ededed] animate-ping" />
          <span className="text-[#8f8f8f] tracking-widest">SYS.BOOT // #2009_TRACKER</span>
          <span className="hidden sm:inline text-[#5c5c5c]">v0.4.0</span>
        </div>
        <WindowControls />
      </div>

      {/* Tactical Corner HUD Brackets */}
      <div className="pointer-events-none absolute inset-x-7 top-14 bottom-7 z-10">
        <span className="absolute top-0 left-0 w-5 h-5 border-t border-l border-white/25" />
        <span className="absolute top-0 right-0 w-5 h-5 border-t border-r border-white/25" />
        <span className="absolute bottom-0 left-0 w-5 h-5 border-b border-l border-white/25" />
        <span className="absolute bottom-0 right-0 w-5 h-5 border-b border-r border-white/25" />
      </div>

      {/* Center Emblem + Kinetic Scrambled Typography */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-center px-6 -mt-6 pointer-events-none">
        {/* App Icon inside Orbital Frame */}
        <div className="relative w-20 h-20 flex items-center justify-center mb-5">
          <div className="absolute inset-0 rounded-[18px] border border-white/20 rotate-45 scale-90 transition-transform duration-700" />
          <div className="absolute -inset-2 rounded-[22px] border border-white/[0.08] animate-spin [animation-duration:9s]" />
          <img
            src="/app-icon.png"
            alt="#2009 tracker"
            className="relative w-14 h-14 rounded-[14px] object-contain border border-white/15 bg-[#0a0a0a]"
          />
        </div>

        {/* Cryptographic Decode Title */}
        <div className="text-center space-y-1.5">
          <div className="font-num text-4xl sm:text-5xl font-bold tracking-tight text-[#ededed]">
            {decodedTitle}
          </div>
          <div className="font-num text-xs sm:text-sm tracking-[0.46em] text-[#8f8f8f] pl-[0.46em]">
            {decodedSub}
          </div>
        </div>

        {/* Numeric Percentage Readout */}
        <div className="mt-7 font-num text-xs tracking-widest text-[#8f8f8f] flex items-center gap-2">
          <span className="text-[#5c5c5c]">LOADING</span>
          <span className="text-sm font-semibold text-[#ededed] w-11 text-right">
            {Math.round(progress).toString().padStart(3, "0")}%
          </span>
        </div>
      </div>

      {/* Bottom Telemetry Console & Segmented Progress Bar */}
      <div className="relative z-10 max-w-lg w-full mx-auto px-8 pb-11 space-y-3 pointer-events-none">
        {/* Step Status Line */}
        <div className="flex items-center justify-between gap-4 text-[11px] font-num">
          <div className="flex items-center gap-2 min-w-0 truncate">
            <span className="px-1.5 py-0.5 rounded bg-white/[0.08] text-[#ededed] text-[10px]">
              {activeStep.code}
            </span>
            <span className="text-[#8f8f8f] truncate">{activeStep.label}</span>
          </div>
          <span className="text-[#5c5c5c] shrink-0">{hexStream}</span>
        </div>

        {/* High-Precision Dual Progress Track */}
        <div className="relative h-1.5 w-full rounded-full bg-white/[0.07] overflow-hidden">
          <div
            style={{ width: `${progress}%` }}
            className="h-full bg-[#ededed] rounded-full transition-[width] duration-75"
          />
        </div>

        {/* Mini Subsystem Checklist Pills */}
        <div className="flex items-center justify-between text-[10px] font-num text-[#5c5c5c] pt-0.5">
          <span className={progress >= 25 ? "text-[#ededed]" : ""}>
            [{progress >= 25 ? "✓" : "·"}] STORE
          </span>
          <span className={progress >= 55 ? "text-[#ededed]" : ""}>
            [{progress >= 55 ? "✓" : "·"}] ASSETS
          </span>
          <span className={progress >= 80 ? "text-[#ededed]" : ""}>
            [{progress >= 80 ? "✓" : "·"}]{" "}
            {encoderName ? "GPU_REC" : "REPLAY"}
          </span>
          <span className={progress >= 96 ? "text-[#ededed]" : ""}>
            [{progress >= 96 ? "✓" : "·"}] TELEMETRY
          </span>
        </div>
      </div>
    </div>
  );
}

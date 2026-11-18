import { useEffect, useRef } from "react";

export type WavePreset =
  | "home"
  | "live"
  | "recorder"
  | "clips"
  | "overview"
  | "matches"
  | "match-detail"
  | "leaderboard"
  | "settings";

interface PresetConfig {
  pitch: number;
  yaw: number;
  amp1: number;
  amp2: number;
  freqX: number;
  freqZ: number;
  speed: number;
  radialPulse: number;
  tint: [number, number, number];
}

const PRESETS: Record<WavePreset, PresetConfig> = {
  home: {
    pitch: 0.56,
    yaw: -0.18,
    amp1: 28,
    amp2: 18,
    freqX: 0.095,
    freqZ: 0.085,
    speed: 0.95,
    radialPulse: 0.0,
    tint: [237, 237, 237],
  },
  live: {
    pitch: 0.62,
    yaw: 0.16,
    amp1: 24,
    amp2: 20,
    freqX: 0.11,
    freqZ: 0.11,
    speed: 1.35,
    radialPulse: 14.0,
    tint: [210, 240, 222],
  },
  recorder: {
    pitch: 0.59,
    yaw: -0.21,
    amp1: 22,
    amp2: 16,
    freqX: 0.105,
    freqZ: 0.105,
    speed: 1.15,
    radialPulse: 11.0,
    tint: [238, 238, 238],
  },
  clips: {
    pitch: 0.66,
    yaw: 0.08,
    amp1: 14,
    amp2: 10,
    freqX: 0.09,
    freqZ: 0.09,
    speed: 0.55,
    radialPulse: 0.0,
    tint: [220, 220, 224],
  },
  overview: {
    pitch: 0.52,
    yaw: 0.24,
    amp1: 24,
    amp2: 16,
    freqX: 0.085,
    freqZ: 0.1,
    speed: 0.85,
    radialPulse: 0.0,
    tint: [237, 237, 237],
  },
  matches: {
    pitch: 0.58,
    yaw: -0.26,
    amp1: 22,
    amp2: 18,
    freqX: 0.075,
    freqZ: 0.125,
    speed: 1.05,
    radialPulse: 0.0,
    tint: [232, 232, 236],
  },
  "match-detail": {
    pitch: 0.64,
    yaw: 0.0,
    amp1: 20,
    amp2: 15,
    freqX: 0.1,
    freqZ: 0.09,
    speed: 0.8,
    radialPulse: 6.0,
    tint: [235, 235, 235],
  },
  leaderboard: {
    pitch: 0.48,
    yaw: 0.3,
    amp1: 32,
    amp2: 20,
    freqX: 0.09,
    freqZ: 0.09,
    speed: 0.9,
    radialPulse: 8.0,
    tint: [240, 240, 240],
  },
  settings: {
    pitch: 0.6,
    yaw: -0.12,
    amp1: 15,
    amp2: 11,
    freqX: 0.11,
    freqZ: 0.11,
    speed: 0.65,
    radialPulse: 0.0,
    tint: [225, 225, 225],
  },
};

interface Shockwave {
  wx: number;
  wz: number;
  bornAt: number;
}

interface WaveDotBackgroundProps {
  preset: WavePreset;
}

export function WaveDotBackground({ preset }: WaveDotBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const targetPresetRef = useRef<PresetConfig>(PRESETS[preset]);

  useEffect(() => {
    targetPresetRef.current = PRESETS[preset];
  }, [preset]);

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

    // Normalized mouse coordinates (-1..1) + smoothed values
    const mouse = {
      nx: 0,
      ny: 0,
      smoothNx: 0,
      smoothNy: 0,
      screenX: width * 0.5,
      screenY: height * 0.5,
      smoothScreenX: width * 0.5,
      smoothScreenY: height * 0.5,
      active: false,
      influence: 0,
    };

    const shockwaves: Shockwave[] = [];

    const onPointerMove = (e: PointerEvent) => {
      if (width <= 0 || height <= 0) return;
      mouse.nx = (e.clientX / width) * 2 - 1;
      mouse.ny = (e.clientY / height) * 2 - 1;
      mouse.screenX = e.clientX;
      mouse.screenY = e.clientY;
      mouse.active = true;
    };

    const onPointerLeave = () => {
      mouse.active = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (width <= 0 || height <= 0) return;
      const nx = (e.clientX / width) * 2 - 1;
      const ny = (e.clientY / height) * 2 - 1;
      shockwaves.push({
        wx: nx * 520,
        wz: ny * 380,
        bornAt: performance.now() * 0.001,
      });
      if (shockwaves.length > 4) {
        shockwaves.shift();
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerleave", onPointerLeave, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });

    // Smoothed live parameters so switching tabs morphs fluidly
    const live: PresetConfig = {
      ...targetPresetRef.current,
      tint: [...targetPresetRef.current.tint] as [number, number, number],
    };

    const COLS = 52;
    const ROWS = 36;
    const SPACING = 31;
    const FOV = 680;
    const CAM_DIST = 690;

    let rafId = 0;
    let phase = 0;
    let lastTime = performance.now() * 0.001;

    const render = () => {
      rafId = window.requestAnimationFrame(render);

      if (document.hidden) {
        lastTime = performance.now() * 0.001;
        return;
      }

      const now = performance.now() * 0.001;
      const dt = Math.min(0.05, Math.max(0.001, now - lastTime));
      lastTime = now;

      // Smoothly interpolate preset parameters on tab change
      const tgt = targetPresetRef.current;
      const morph = 1 - Math.exp(-dt * 4.2);
      live.pitch += (tgt.pitch - live.pitch) * morph;
      live.yaw += (tgt.yaw - live.yaw) * morph;
      live.amp1 += (tgt.amp1 - live.amp1) * morph;
      live.amp2 += (tgt.amp2 - live.amp2) * morph;
      live.freqX += (tgt.freqX - live.freqX) * morph;
      live.freqZ += (tgt.freqZ - live.freqZ) * morph;
      live.speed += (tgt.speed - live.speed) * morph;
      live.radialPulse += (tgt.radialPulse - live.radialPulse) * morph;
      live.tint[0] += (tgt.tint[0] - live.tint[0]) * morph;
      live.tint[1] += (tgt.tint[1] - live.tint[1]) * morph;
      live.tint[2] += (tgt.tint[2] - live.tint[2]) * morph;

      phase += dt * live.speed;

      // Smooth mouse follow
      const mLerp = 1 - Math.exp(-dt * 7.5);
      mouse.smoothNx += (mouse.nx - mouse.smoothNx) * mLerp;
      mouse.smoothNy += (mouse.ny - mouse.smoothNy) * mLerp;
      mouse.smoothScreenX += (mouse.screenX - mouse.smoothScreenX) * mLerp;
      mouse.smoothScreenY += (mouse.screenY - mouse.smoothScreenY) * mLerp;
      mouse.influence += ((mouse.active ? 1 : 0) - mouse.influence) * (1 - Math.exp(-dt * 5));

      // Clear pure black background
      ctx.fillStyle = "#000000";
      ctx.fillRect(0, 0, width, height);

      // Camera rotation angles reactive to mouse movement
      const yaw = live.yaw + mouse.smoothNx * 0.22;
      const pitch = Math.max(0.22, Math.min(1.05, live.pitch + mouse.smoothNy * 0.14));

      const cosYaw = Math.cos(yaw);
      const sinYaw = Math.sin(yaw);
      const cosPitch = Math.cos(pitch);
      const sinPitch = Math.sin(pitch);

      // Cursor projected into approximate world plane for 3D wave ripple
      const cursorWorldX = mouse.smoothNx * 520;
      const cursorWorldZ = mouse.smoothNy * 360;

      const centerX = width * 0.54; // Slightly right of sidebar for balanced framing
      const centerY = height * 0.56;

      const halfCols = (COLS - 1) * 0.5;
      const halfRows = (ROWS - 1) * 0.5;

      const rTint = Math.round(live.tint[0]);
      const gTint = Math.round(live.tint[1]);
      const bTint = Math.round(live.tint[2]);

      // Prune expired click shockwaves
      while (shockwaves.length > 0 && now - shockwaves[0].bornAt > 2.6) {
        shockwaves.shift();
      }

      // Draw back-to-front for natural depth ordering
      for (let rz = 0; rz < ROWS; rz++) {
        const gz = rz - halfRows;
        const wzBase = gz * SPACING;

        for (let cx = 0; cx < COLS; cx++) {
          const gx = cx - halfCols;
          const wxBase = gx * SPACING;

          // Base 3D harmonic wave
          let wy =
            Math.sin(gx * live.freqX * 2.6 + phase * 1.4) * live.amp1 +
            Math.cos(gz * live.freqZ * 2.6 + phase * 1.1) * live.amp2 +
            Math.sin((gx + gz) * 0.14 - phase * 0.85) * 9;

          // Optional concentric pulse (e.g. Live Match radar wave)
          if (live.radialPulse > 0.2) {
            const distCenter = Math.hypot(wxBase, wzBase);
            wy += Math.sin(distCenter * 0.018 - phase * 2.4) * live.radialPulse;
          }

          // Click shockwaves in 3D world space
          for (let s = 0; s < shockwaves.length; s++) {
            const sw = shockwaves[s];
            const age = now - sw.bornAt;
            const d = Math.hypot(wxBase - sw.wx, wzBase - sw.wz);
            const waveFront = age * 360;
            const band = Math.abs(d - waveFront);
            if (band < 95) {
              const decay = Math.max(0, 1 - age / 2.6);
              wy -= Math.cos((band / 95) * Math.PI * 0.5) * 26 * decay;
            }
          }

          // Rotate around Y (yaw)
          const rx = wxBase * cosYaw - wzBase * sinYaw;
          const rz1 = wxBase * sinYaw + wzBase * cosYaw;

          // Preliminary screen projection check for accurate screen-space mouse interaction
          const preY = wy * cosPitch - rz1 * sinPitch;
          const preZ = wy * sinPitch + rz1 * cosPitch + CAM_DIST;
          if (preZ <= 80) continue;

          const preScale = FOV / preZ;
          const preSx = centerX + rx * preScale;
          const preSy = centerY + preY * preScale;

          // Screen-space + world-space interactive cursor elevation & glow
          let cursorBoost = 0;
          if (mouse.influence > 0.01) {
            const dxScreen = preSx - mouse.smoothScreenX;
            const dyScreen = preSy - mouse.smoothScreenY;
            const distSqScreen = dxScreen * dxScreen + dyScreen * dyScreen;
            const radiusSq = 185 * 185;
            if (distSqScreen < radiusSq) {
              const falloff = 1 - distSqScreen / radiusSq;
              cursorBoost = falloff * falloff * mouse.influence;
              // Lift dot upward in 3D Y (negative Y is up in screen space)
              wy -= cursorBoost * 34;
            } else {
              // Subtle secondary world-space wake
              const dwx = wxBase - cursorWorldX;
              const dwz = wzBase - cursorWorldZ;
              const wDistSq = dwx * dwx + dwz * dwz;
              if (wDistSq < 220 * 220) {
                const wf = 1 - wDistSq / (220 * 220);
                wy -= wf * wf * 10 * mouse.influence;
              }
            }
          }

          // Final 3D -> 2D perspective projection
          const py = wy * cosPitch - rz1 * sinPitch;
          const pz = wy * sinPitch + rz1 * cosPitch + CAM_DIST;
          if (pz <= 80) continue;

          const scale = FOV / pz;
          const sx = centerX + rx * scale;
          const sy = centerY + py * scale;

          if (sx < -20 || sx > width + 20 || sy < -20 || sy > height + 20) {
            continue;
          }

          // Edge fade so grid dissolves into pure black seamlessly
          const edgeX = 1 - Math.pow(Math.abs(gx / halfCols), 2.6);
          const edgeZ = 1 - Math.pow(Math.abs(gz / halfRows), 2.4);
          const edgeFade = Math.max(0, edgeX * edgeZ);
          if (edgeFade <= 0.01) continue;

          // Height highlight (wave crests catch subtle light)
          const crestNorm = Math.max(0, Math.min(1, (40 - wy) / 85));
          const depthFade = Math.max(0.12, Math.min(1, (1150 - pz) / 760));

          const baseAlpha = (0.09 + crestNorm * 0.24) * depthFade * edgeFade;
          const alpha = Math.min(0.88, baseAlpha + cursorBoost * 0.52);

          const radius = Math.max(
            0.75,
            (1.15 + crestNorm * 0.65) * scale + cursorBoost * 1.35,
          );

          ctx.fillStyle = `rgba(${rTint}, ${gTint}, ${bTint}, ${alpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(sx, sy, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    rafId = window.requestAnimationFrame(render);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="fixed inset-0 pointer-events-none z-0"
    />
  );
}

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const COMPLETED_DIR = path.join(ROOT, "完成品");
const KEY_PATH = path.join(ROOT, ".tauri-keys", "updater.key");
const REPO = "numeragon/2009-tracker";

const collectOnly = process.argv.includes("--collect-only");

const tauriConf = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
);
const version = tauriConf.version;

if (!collectOnly) {
  const env = { ...process.env };
  if (!env.TAURI_SIGNING_PRIVATE_KEY && fs.existsSync(KEY_PATH)) {
    env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(KEY_PATH, "utf8").trim();
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
  }

  console.log(`[build] Building Valorant Tracker v${version} ...`);
  const cmd = process.platform === "win32" ? "npx.cmd" : "npx";
  const res = spawnSync(cmd, ["tauri", "build"], {
    cwd: ROOT,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

fs.mkdirSync(COMPLETED_DIR, { recursive: true });

// Remove stale files in 完成品 so only latest clean artifacts remain
for (const oldName of fs.readdirSync(COMPLETED_DIR)) {
  fs.rmSync(path.join(COMPLETED_DIR, oldName), { recursive: true, force: true });
}

const releaseDir = path.join(ROOT, "src-tauri", "target", "release");
const nsisDir = path.join(releaseDir, "bundle", "nsis");
const msiDir = path.join(releaseDir, "bundle", "msi");

// 1. Standalone Portable .exe
const standaloneSrc = path.join(releaseDir, "valorant-tracker.exe");
if (fs.existsSync(standaloneSrc)) {
  const standaloneDst = path.join(COMPLETED_DIR, "Valorant Tracker (単体起動版).exe");
  fs.copyFileSync(standaloneSrc, standaloneDst);
  console.log(`[完成品] Copied: ${standaloneDst}`);
}

// 2. NSIS Setup .exe + .sig + latest.json
let sigContent = null;
let setupAssetFileName = `Valorant-Tracker_${version}_x64-setup.exe`;

if (fs.existsSync(nsisDir)) {
  for (const f of fs.readdirSync(nsisDir)) {
    const full = path.join(nsisDir, f);
    if (f.endsWith("-setup.exe")) {
      const dst = path.join(COMPLETED_DIR, f);
      fs.copyFileSync(full, dst);
      console.log(`[完成品] Copied: ${dst}`);
    } else if (f.endsWith(".sig")) {
      sigContent = fs.readFileSync(full, "utf8").trim();
      const basePayload = f.replace(/\.sig$/, "");
      // Sanitize spaces to hyphens for clean GitHub Release URLs
      setupAssetFileName = basePayload.replace(/\s+/g, "-");
      fs.copyFileSync(full, path.join(COMPLETED_DIR, `${setupAssetFileName}.sig`));
    }
  }
}

// 3. MSI Installer
if (fs.existsSync(msiDir)) {
  for (const f of fs.readdirSync(msiDir)) {
    if (f.endsWith(".msi")) {
      const dst = path.join(COMPLETED_DIR, f);
      fs.copyFileSync(path.join(msiDir, f), dst);
      console.log(`[完成品] Copied: ${dst}`);
    }
  }
}

// 4. Generate latest.json if signed
if (sigContent) {
  const latestJson = {
    version,
    notes: `Valorant Tracker v${version}`,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: sigContent,
        url: `https://github.com/${REPO}/releases/download/v${version}/${setupAssetFileName}`,
      },
    },
  };
  const latestPath = path.join(COMPLETED_DIR, "latest.json");
  fs.writeFileSync(latestPath, JSON.stringify(latestJson, null, 2), "utf8");
  console.log(`[完成品] Generated updater manifest: ${latestPath}`);
}

console.log(`\nDone! All artifacts are ready in: ${COMPLETED_DIR}`);

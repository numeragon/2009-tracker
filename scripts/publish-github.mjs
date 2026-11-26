import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const COMPLETED_DIR = path.join(ROOT, "完成品");
const OWNER = "numeragon";
const REPO = "2009-tracker";

const args = process.argv.slice(2);
const skipBuild = args.includes("--skip-build");
const nextVersionArg = args.find((a) => /^\d+\.\d+\.\d+$/.test(a));

function getTokenFromGitCredentialManager() {
  try {
    const res = spawnSync("git", ["credential", "fill"], {
      cwd: ROOT,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    if (res.status === 0 && res.stdout) {
      const m = res.stdout.match(/^password=(.+)$/m);
      if (m) return m[1].trim();
    }
  } catch {
    // Ignore
  }
  return "";
}

function updateVersionStrings(newVer) {
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  pkg.version = newVer;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

  const tauriConfPath = path.join(ROOT, "src-tauri", "tauri.conf.json");
  const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
  tauriConf.version = newVer;
  fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n", "utf8");

  const cargoPath = path.join(ROOT, "src-tauri", "Cargo.toml");
  const cargoRaw = fs.readFileSync(cargoPath, "utf8");
  const updatedCargo = cargoRaw.replace(
    /^version\s*=\s*"[^"]+"/m,
    `version = "${newVer}"`,
  );
  fs.writeFileSync(cargoPath, updatedCargo, "utf8");
  console.log(`[version] Bumped project version to v${newVer}`);
}

if (nextVersionArg) {
  updateVersionStrings(nextVersionArg);
}

const tauriConf = JSON.parse(
  fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
);
const version = tauriConf.version;
const tag = `v${version}`;

const token =
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  (process.env.GITHUB_TOKEN_FILE && fs.existsSync(process.env.GITHUB_TOKEN_FILE)
    ? fs.readFileSync(process.env.GITHUB_TOKEN_FILE, "utf8").trim()
    : "") ||
  getTokenFromGitCredentialManager();

if (!token) {
  console.error(
    "ERROR: GitHub token not found in GITHUB_TOKEN or Git Credential Manager.",
  );
  process.exit(1);
}

if (!skipBuild) {
  const buildRes = spawnSync(process.execPath, [path.join(__dirname, "build-and-collect.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (buildRes.status !== 0) {
    process.exit(buildRes.status ?? 1);
  }
}

// Commit and push source updates if any
spawnSync("git", ["add", "-A"], { cwd: ROOT, stdio: "inherit" });
const diffCheck = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
if (diffCheck.stdout && diffCheck.stdout.trim().length > 0) {
  spawnSync("git", ["commit", "-m", `chore: release ${tag}`], { cwd: ROOT, stdio: "inherit" });
}
const b64 = Buffer.from(`x-access-token:${token}`, "ascii").toString("base64");
spawnSync(
  "git",
  ["-c", `http.https://github.com/.extraheader=AUTHORIZATION: basic ${b64}`, "push", "origin", "main"],
  { cwd: ROOT, stdio: "inherit" },
);

async function ghApi(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub API ${res.status} ${url}: ${txt}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function main() {
  console.log(`[github] Publishing release ${tag} to ${OWNER}/${REPO} ...`);

  let release = null;
  try {
    release = await ghApi(
      `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${encodeURIComponent(tag)}`,
    );
  } catch {
    release = await ghApi(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag_name: tag,
        target_commitish: "main",
        name: `#2009 tracker ${tag}`,
        body: `# #2009 tracker ${tag}\n- ゲーム内オーバーレイを追加\n  - エージェント選択が始まると、両チームのパーティ・ランク・レベル・エージェントを画面中央にコンパクト表示\n  - 各行に K/D・HS%・勝率・ピークランク・匿名解除・リアルタイムのピック状況を表示\n  - 敵ピックがRiot非公開の場合は「選択中（非公開）」「確定（非公開）」とロック数を表示\n  - プレイヤーにカーソルを合わせると、装備中の全武器スキンをホバーカードで表示\n  - クリックはゲームに透過。表示 / 非表示はグローバルホットキー（初期値 F8、設定画面で変更可能）\n  - 表示 / 非表示はフェードイン・フェードアウトでアニメーション\n  - 試合開始で自動的に非表示。設定画面から「今すぐ表示 / 隠す」も可能\n- Riot Mobile 2FA（TOTP）認証コードを追加\n  - 6桁コードをすりガラス状にぼかし、カーソルを合わせると表示\n  - Base32 / otpauth URI の手動登録、Riot2FAアプリからのインポート、Riotログインからのシークレット取得に対応\n- ライブ画面のパーティ表示を両チームに拡張\n  - 味方はローカルプレゼンスから正確に取得\n  - 敵は直近の試合履歴から推定（「推定」と表示）\n- パーティ表示のチップ（P1 / P2）と自分のパーティの強調`,
        draft: false,
        prerelease: false,
      }),
    });
  }

  const existingAssets = release.assets || [];
  const filesToUpload = [];

  const nsisDir = path.join(ROOT, "src-tauri", "target", "release", "bundle", "nsis");
  let setupSrc = null;
  let sigSrc = null;
  let setupUploadName = `2009-tracker_${version}_x64-setup.exe`;

  if (fs.existsSync(nsisDir)) {
    for (const f of fs.readdirSync(nsisDir)) {
      if (!f.includes(`_${version}_`)) continue;
      if (f.endsWith(".sig")) {
        sigSrc = path.join(nsisDir, f);
        setupUploadName = f.replace(/\.sig$/, "").replace(/\s+/g, "-");
        const payloadFile = path.join(nsisDir, f.replace(/\.sig$/, ""));
        if (fs.existsSync(payloadFile)) {
          setupSrc = payloadFile;
        }
      }
    }
  }

  if (!setupSrc || !sigSrc) {
    throw new Error("Signed NSIS installer or .sig file not found. Run build:release first.");
  }

  const latestJsonPath = path.join(COMPLETED_DIR, "latest.json");
  const sigContent = fs.readFileSync(sigSrc, "utf8").trim();
  const latestJson = {
    version,
    notes: `#2009 tracker v${version} - ゲーム内オーバーレイ（ピック画面の自動表示・インベントリのホバー表示・フェードイン/アウト・F8ショートカット）・敵ピックの取得状況/ロック数表示・Riot Mobile 2FA認証コード・両チームのパーティ表示`,
    pub_date: new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: sigContent,
        url: `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${setupUploadName}`,
      },
    },
  };
  fs.mkdirSync(COMPLETED_DIR, { recursive: true });
  fs.writeFileSync(latestJsonPath, JSON.stringify(latestJson, null, 2), "utf8");

  filesToUpload.push({
    name: setupUploadName,
    path: setupSrc,
    contentType: "application/octet-stream",
  });
  filesToUpload.push({
    name: `${setupUploadName}.sig`,
    path: sigSrc,
    contentType: "text/plain",
  });
  filesToUpload.push({
    name: "latest.json",
    path: latestJsonPath,
    contentType: "application/json",
  });

  const standaloneExe = path.join(ROOT, "src-tauri", "target", "release", "valorant-tracker.exe");
  if (fs.existsSync(standaloneExe)) {
    filesToUpload.push({
      name: `2009-tracker_${version}_Portable.exe`,
      path: standaloneExe,
      contentType: "application/octet-stream",
    });
  }

  for (const item of filesToUpload) {
    const dup = existingAssets.find((a) => a.name === item.name);
    if (dup) {
      await ghApi(
        `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${dup.id}`,
        { method: "DELETE" },
      );
    }

    const bytes = fs.readFileSync(item.path);
    const uploadUrl = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(item.name)}`;
    console.log(`[github] Uploading ${item.name} (${(bytes.length / 1024 / 1024).toFixed(2)} MB) ...`);
    await ghApi(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": item.contentType,
        "Content-Length": String(bytes.length),
      },
      body: bytes,
    });
  }

  console.log(`\nSuccessfully published ${tag}: ${release.html_url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

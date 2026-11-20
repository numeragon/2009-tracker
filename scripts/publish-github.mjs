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
        body: `# #2009 tracker ${tag}\n- ライブ画面にパーティ表示を追加（自分が組んでいるパーティの人数とメンバーの「パーティ」バッジ。10秒キャッシュ）\n- エージェント選択中の相手ピックをリアルタイム更新（2秒間隔・変化時にアニメーション・「2秒ごと更新」表示）。それ以外は15秒\n- ロッカーの配置をゲーム内コレクション画面に合わせて刷新（サイドアーム / サブマシンガン・ショットガン・近接 / ライフル / スナイパー・マシンガンのカテゴリ別カラム、コスト順）\n- 画像のバツ表示を修正（スキン画像→武器画像のフォールバック、無効なプレイヤーカードIDの除外）\n- ロッカー表示: 試合内の全プレイヤー分の装備スキンを返す pregame/core-game loadouts API に切り替え\n- 匿名解除: 解決済みの名前をPUUID単位で永続キャッシュ。未解決の匿名プレイヤーは HenrikDev のPUUID検索で実名を取得（結果は永久キャッシュ）\n- ライブ画面のランク/RR/ピーク/勝率/K/D/HS とリーダーボードを Riot 直のAPIに置き換え（レートリミット対策）\n- 多重起動を防止（トレイ格納中の再起動で既存ウィンドウを復元）\n- クロスヘア取得の HTTP 403 / 500 を修正\n- ショップ: ストア取得の HTTP 404 を修正・複数Riotアカウント対応\n- ロビー内のパーティメンバー表示（リーダー / 準備完了 / ランク付き）\n- ショップ確認: デイリーストア・ナイトマーケット・注目バンドル・VP/RP 残高\n- 試合開始前に自分のチームの先行・後攻を表示`,
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
    notes: `#2009 tracker v${version} - ライブ画面のパーティ表示・エージェント選択の2秒リアルタイム更新・ロッカーのカテゴリ別レイアウト・画像バツ修正・匿名解除・Riot直API化`,
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

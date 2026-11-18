import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const nextVersion = process.argv.slice(2).find((a) => /^\d+\.\d+\.\d+$/.test(a));
if (!nextVersion) {
  console.error("Usage: npm.cmd run release:cloud -- <version> (e.g. 0.2.0)");
  process.exit(1);
}

const pkgPath = path.join(ROOT, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = nextVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");

const tauriConfPath = path.join(ROOT, "src-tauri", "tauri.conf.json");
const tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, "utf8"));
tauriConf.version = nextVersion;
fs.writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + "\n", "utf8");

const cargoPath = path.join(ROOT, "src-tauri", "Cargo.toml");
const cargoRaw = fs.readFileSync(cargoPath, "utf8");
fs.writeFileSync(
  cargoPath,
  cargoRaw.replace(/^version\s*=\s*"[^"]+"/m, `version = "${nextVersion}"`),
  "utf8",
);

const tag = `v${nextVersion}`;
spawnSync("git", ["add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml"], {
  cwd: ROOT,
  stdio: "inherit",
});
spawnSync("git", ["commit", "-m", `chore: release ${tag}`], { cwd: ROOT, stdio: "inherit" });
spawnSync("git", ["tag", "-f", tag], { cwd: ROOT, stdio: "inherit" });
spawnSync("git", ["push", "origin", "main"], { cwd: ROOT, stdio: "inherit" });
spawnSync("git", ["push", "-f", "origin", tag], { cwd: ROOT, stdio: "inherit" });

console.log(`\nPushed ${tag}! GitHub Actions is now building & publishing the auto-update release:`);
console.log("https://github.com/numeragon/2009-tracker/actions");

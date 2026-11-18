# Valorant Tracker

VALORANT のプレイヤー戦績・進行中の試合（ライブマッチ）を閲覧できる Windows デスクトップアプリ（Tauri 2 + React + TypeScript + Vite）です。

## 完成品フォルダ（ビルド出力先）

ビルド結果はすべてプロジェクト直下の **`完成品`** フォルダ（`C:\Users\X280\Documents\vlrt-tracker\完成品`）に自動出力されます：

- `Valorant Tracker (単体起動版).exe`（インストール不要・ポータブル版）
- `Valorant Tracker_<version>_x64-setup.exe`（日本語対応インストーラー）
- `Valorant Tracker_<version>_x64_en-US.msi`（MSI インストーラー）
- `latest.json`（自動アップデート配信マニフェスト）

---

## 自動アップデートと新バージョンの配信方法

アプリ起動時（および30分ごと・設定画面の手動確認ボタン）に GitHub リポジトリ [`numeragon/2009-tracker`](https://github.com/numeragon/2009-tracker/releases) の最新リリースを確認し、新バージョンがあれば**自動でダウンロード・インストールして再起動**します。

### 新しいバージョンをビルド＆GitHubへ自動アップロードするコマンド

機能追加や変更を行ったあと、バージョン番号（例: `0.2.0`）を指定して以下を1行実行するだけで、**バージョン更新 → 署名付きビルド → `完成品` フォルダ出力 → GitHub Release への自動アップロード**まで完了します：

```powershell
cd C:\Users\X280\Documents\vlrt-tracker
npm.cmd run publish:update -- 0.2.0
```

ローカルで `完成品` フォルダへのビルドだけ行う場合：

```powershell
npm.cmd run build:release
```

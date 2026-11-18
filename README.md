# Valorant Tracker

VALORANT のプレイヤー戦績・進行中の試合（ライブマッチ）を閲覧できる個人利用向け Windows デスクトップアプリ（Tauri 2 + React + TypeScript + Vite）です。

## 主な機能

- **APIキー組み込み済み**：起動後すぐに設定不要で検索・ライブマッチ取得が可能（設定画面から別のカスタムAPIキーへの切り替えも可能）
- **インタラクティブ 3D ウェーブドット背景**：
  - 全タブに対応したマウス連動 3D ドットアニメーション（カーソル移動で3D視点チルト＆ドット隆起、クリックで3Dショックウェーブ波紋、タブごとに波形が滑らかに変化）
  - ウィンドウ最小化時は自動で描画停止し、ゲーム中の CPU / GPU 負荷ゼロで動作
- **試合中（ライブマッチ）情報取得**：
  - 起動中の VALORANT クライアントからエージェント選択中・試合進行中のマッチを自動検出
  - 味方・相手チーム全員の使用エージェント、現在ランク・RR、ピークランク、**K/D（および HS%）**、今シーズン勝率・試合数を一覧表示（15秒ごとの自動更新対応）
- **プレイヤー検索**：Riot ID（`名前#タグ`）での検索、検索履歴（直近10件）、お気に入り（ピン留め）保存
- **プロフィール概要**：
  - プレイヤーカード、アカウントレベル、リージョン表示
  - 現在ランク（アイコン・ランク名・RR・直近RR増減）とピークランク
  - シーズン勝敗数・勝率
  - 直近コンペティティブ最大20試合のサマリースタッツ（K/D、勝率、HS%、平均ACS、平均ADR、合計K/D/A）
  - RR推移折れ線グラフ（Recharts）
- **試合履歴・試合詳細**：直近20試合のリスト表示、モード別フィルタ、両チーム全10人のスコアボード、ラウンド推移

---

## ビルド済みファイル（すぐ使える実行ファイル）

- **単体実行版（インストール不要 `.exe`）**  
  `src-tauri\target\release\valorant-tracker.exe`
- **日本語対応インストーラー（NSIS Setup `.exe`）**  
  `src-tauri\target\release\bundle\nsis\Valorant Tracker_0.1.0_x64-setup.exe`
- **MSI インストーラー**  
  `src-tauri\target\release\bundle\msi\Valorant Tracker_0.1.0_x64_en-US.msi`

---

## 開発・再ビルド手順

PowerShell で実行する場合：

```powershell
cd C:\Users\X280\Documents\vlrt-tracker
npm.cmd install

# 開発モード起動
npm.cmd run tauri dev

# リリースビルド（.exe / インストーラー生成）
npx.cmd tauri build
```

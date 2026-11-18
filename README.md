# #2009 tracker

VALORANT デスクトップ戦績トラッカー ＆ 100% GPU インスタントリプレイ録画・クリップ編集ツール（Windows / Tauri v2）。

## 主な機能

- **プレイヤー戦績・RR推移・試合履歴詳細**: Riot ID (`Name#Tag`) でランク・ピークランク・K/D・ADR・HS%・エージェント統計・全ラウンドスコアボードを高速表示
- **エージェント別・マップ別スタッツ**: 直近の試合から使用回数・勝率・K/D・ACS を自動集計し、プロフィールのタブで一覧表示
- **リージョン別リーダーボード**: 全6リージョン (`AP / KR / NA / EU / BR / LATAM`) の上位 15,000 名ランキング、Radiant / Immortal ボーダー RR 表示、TOP3 ポディウム、Riot ID による順位検索
- **試合中（ライブ）自動検出**: 起動中の VALORANT からエージェント選択画面・試合中の全10人のランク・RR・ピークランク・勝率・K/D をリアルタイム取得
- **インスタントリプレイ録画（100% GPU）**:
  - DXGI Desktop Duplication + D3D11 NV12 + Media Foundation ハードウェア H.264 エンコーダー（NVENC / AMF / QuickSync）による超軽量バックグラウンド常時バッファ録画
  - 試合中に `F9`（カスタマイズ可）を押すだけで直近 5秒〜5分を無劣化 MP4 として即座に保存
  - 3チャンネル独立 WASAPI オーディオミキサー（プロセス分離されたゲーム音声 / ゲーム除外デスクトップ音声 / マイク最大200%）
  - システムトレイ常駐・グローバルホットキー・Windows 自動起動対応
- **クリップライブラリ＆マルチトラック動画編集**:
  - フォルダ整理・外部動画インポート・Windows ごみ箱連携・高速キーフレームサムネイル＆音声波形キャッシュ
  - トリミング・分割・静止画フレーム挿入・再生速度変更 (`0.25x〜4x`)・音量＆フェードカーブ・画面比率 (`16:9 / 9:16 / 1:1 / 4:3`)・90°回転＆反転・クロップ
  - 無劣化ストリームコピー（1秒未満）および GPU ハードウェア再エンコード書き出し（Discord 共有向け最大ファイルサイズ MB 指定対応）
- **自動アップデート**: GitHub Releases (`numeragon/2009-tracker`) と連携し、起動時に新バージョンを自動検知・ワンクリック更新

## 起動と API キー設定

### 必要なもの

- Windows 10 / 11
- Node.js 20 以上・npm
- Tauri 2 のビルド環境（Rust stable / Visual Studio Build Tools / WebView2）

### 開発起動

```powershell
npm install
npm.cmd run tauri dev
```

UI だけをブラウザで確認する場合は `npm.cmd run dev`（既定: http://localhost:1420）。
ただし試合中ライブ検出・録画・自動アップデートは Tauri 実行時のみ動作します。

### API キーの設定

1. https://api.henrikdev.xyz/dashboard で HenrikDev API キーを取得する
2. 左サイドバーの「設定」を開き、API キー欄へ貼り付けて「保存する」
3. 画面上部またはホーム中央の検索バーへ Riot ID（例: `Player#JP1`）を入力して検索

キーは PC 内（Tauri store / localStorage）にのみ保存され、HenrikDev API へのリクエストヘッダー以外には送信されません。

## ビルド・リリースコマンド

```powershell
# ローカルビルド＋「完成品」フォルダへ単体起動版 .exe とインストーラーを出力
npm.cmd run build:release

# バージョン更新＋ビルド＋「完成品」出力＋GitHub Releases 自動アップロード（自動アップデート配信）
npm.cmd run publish:update 0.3.0
```

## ライセンス・クレジット

本ソフトウェアは [GPL-3.0-or-later](LICENSE) ライセンスのもとで公開されています。

- インスタントリプレイ録画および Media Foundation GPU クリップ編集エンジンはオープンソースの [santiremedi/clippy](https://github.com/santiremedi/clippy) (`GPL-3.0-or-later`) のコードをベースに移植・統合しています。

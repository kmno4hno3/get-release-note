# get-release-note

## monitor-releases.ts
`scripts/monitor-releases.ts` は対象リポジトリの最新リリースを取得し、Mattermost の Incoming Webhook に通知するスクリプトです。

### 事前準備
- `MATTERMOST_WEBHOOK_URL` : 通知先の Webhook URL（必須）
- `TARGET_REPOSITORIES` または `TARGET_REPOSITORY` : 監視対象リポジトリ（`owner/name` 形式、複数指定はスペース/カンマ区切り）
- `GITHUB_TOKEN` : GitHub API 呼び出し用のトークン（オプション）
- `GEMINI_API_KEY`, `GEMINI_MODEL` : Gemini での翻訳を有効化したい場合に設定
- `NPM_PACKAGE` : npm のパッケージ名を明示的に指定する場合に設定
- `STATE_DIR` : リリース確認済みタグを保存するディレクトリ（未指定時は `release-monitor-state/state.json`）

### 実行例
```bash
pnpm install
npx ts-node scripts/monitor-releases.ts
```

実行後は `STATE_DIR/state.json` に既知の最新タグが保存され、次回実行時は更新分のみ通知します。

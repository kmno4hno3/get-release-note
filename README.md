# 外部リポジトリのリリース監視通知

このリポジトリの GitHub Actions ワークフローは、指定した外部 GitHub リポジトリの最新リリースを定期的にポーリングし、新しいリリースを検出した場合に Mattermost へ通知します。

## 前提条件

- 通知先チャンネルで Incoming Webhook URL を取得済みであること
- 監視対象の GitHub リポジトリ名（`owner/name` 形式）を把握していること

## 設定手順

1. GitHub のリポジトリ設定画面で `Settings` → `Secrets and variables` → `Actions` を開きます。
2. `Variables` タブに `TARGET_REPOSITORY` を追加し、監視したいリポジトリを `owner/name` 形式で登録します。
3. `Secrets` タブに `MATTERMOST_WEBHOOK_URL` を追加し、Mattermost の Incoming Webhook URL を登録します。

## ワークフローの動作

- ワークフロー定義: `.github/workflows/notify-mattermost.yml`
- トリガー:
  - 毎時 0 分 (`cron: '0 * * * *'`)
  - `workflow_dispatch` による手動実行
- フロー:
  1. GitHub API (`releases/latest`) から最新リリースを取得
  2. リポジトリ変数 `LAST_SEEN_RELEASE` と比較し、未通知のタグのみ通知
  3. Mattermost へ整形済みメッセージを投稿
  4. 通知後に `LAST_SEEN_RELEASE` を最新タグで更新

## 初回実行の確認方法

1. `Actions` タブから `Monitor External Release` ワークフローを開きます。
2. `Run workflow` で手動実行し、成功後に Mattermost へ通知が届くこととリポジトリ変数 `LAST_SEEN_RELEASE` が作成されたことを確認します。

## カスタマイズ

- ポーリング頻度を変更する場合は、ワークフロー内の `schedule` セクションで cron 式を調整してください。
- 通知内容を変更したい場合は、`Mattermostメッセージ生成` ステップの Python スクリプトを編集します。

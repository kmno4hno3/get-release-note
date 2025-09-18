# 外部リポジトリのリリース監視通知

このリポジトリの GitHub Actions ワークフローは、指定した外部 GitHub リポジトリの最新リリースを定期的にポーリングし、新しいリリースを検出した場合に Mattermost へ通知します。通知済みのタグはリポジトリ内の専用 Issue に記録し、重複通知を防ぎます。

## 前提条件

- 通知先チャンネルで Incoming Webhook URL を取得済みであること
- 監視対象の GitHub リポジトリ名（`owner/name` 形式）を把握していること

## 設定手順

1. GitHub のリポジトリ設定 (`Settings` → `Secrets and variables` → `Actions`) を開きます。
2. `Secrets` タブに Mattermost の Incoming Webhook URL を `MATTERMOST_WEBHOOK_URL` として登録します。
3. `Variables` タブに `TARGET_REPOSITORY` を追加し、監視したいリポジトリを `owner/name` 形式で登録します。
   - 例: `octocat/Hello-World`

## ワークフローの動作

- ワークフロー定義: `.github/workflows/notify-mattermost.yml`
- トリガー:
  - 毎時 0 分 (`cron: '0 * * * *'`)
  - `workflow_dispatch` による手動実行
- フロー:
  1. GitHub API (`releases/latest`) から最新リリースを取得
  2. リポジトリ内の Issue（ラベル: `release-monitor`）に保存された前回通知タグと比較
  3. 新しいタグであれば Mattermost へ整形済みメッセージを投稿
  4. Issue の本文に最新タグ JSON (`{"last_tag":"..."}`) を保存

## 初回実行の確認方法

1. `Actions` タブから `Monitor External Release` ワークフローを開きます。
2. `Run workflow` で手動実行し、成功後に Mattermost へ通知が届くことと、リポジトリ Issue に「External Release Monitor State」が作成されていることを確認します。
   - Issue の本文に現在通知済みのタグが JSON で保存されます。

## カスタマイズ

- ポーリング頻度を変更する場合は、ワークフロー内 `schedule` セクションの cron 式を調整してください。
- 通知文面を変更したい場合は、`Mattermostメッセージ生成` ステップの文字列整形部分を編集します。
- Issue 名やラベル名を変更する場合は、ワークフロー内の該当文字列を同じ値で置き換えてください。

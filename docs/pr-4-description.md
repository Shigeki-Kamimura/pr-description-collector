# PR #4: PRディスクリプション取得バックエンド側取得用ロジック開発

Fixes #2

## 背景 / 目的

Issue #2（GitHubのPR本文（Markdown）を取得し、後続でチェックリスト解析・HTML化・保存へ繋げる）の前段として、まず「サーバー側でGitHubからPR本文を取得できること」と「UIからその結果を確認できる導線」を作る。

このPRのスコープは **取得・表示・解析の入口を整備するところまで**。
（OneDrive保存やHTML成果物の生成は未実装 / 別PRで対応）

## 実装したこと

### 1) GitHub取得API（サーバー側）を追加

- `POST /api/collect`（React Router action）を追加
- `owner / repo / prNumber` を受け取り、GitHub REST API から以下を取得してJSONで返す
  - PRメタ情報（title/body/url 等）
  - PR本文（Markdown）
  - PRレビュー一覧（state, submittedAt, userLogin 等）
  - `hasApproved`（レビュー一覧に `APPROVED` が1件でも含まれるかの簡易判定）

### 2) GitHubアクセスを Octokit 化し、認証を env で切替

- GitHub API呼び出しは `app/services/github.server.ts` に集約
- 認証方式は以下を env で切替
  - `GITHUB_TOKEN` or `GITHUB_PAT`（トークン認証）
  - `GITHUB_APP_ID` / `GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY`（GitHub App installation token）
- 取得結果はアプリ内の最小限の型（`PullRequest`, `PullRequestReview`）へ正規化し、Octokitの型をUI側へ漏らさない

### 3) トップ画面に取得UIを追加し、Markdownをレンダリング表示

- owner/repo/prNumber を入力 → 「Get Description」で `/api/collect` を呼び出す導線を追加
- 取得したPR本文（Markdown）を **markdown-it でレンダリング**して読める形で表示
  - `html: false`（Markdown内の生HTMLは無効化）
  - `markdown-it-task-lists` で `- [ ]` / `- [x]` をcheckboxに変換
- 「Parse Checklist」（既存action）も維持しつつ、解析対象は hidden input に保持する形に整理

### 4) UIの細部調整

- 取得ボタン直下のメッセージ（error/hint）の表示/非表示でレイアウトがズレる問題に対し、メッセージ表示領域の高さを固定（`btn-status`）
- 入力/ボタン周りのCSSユーティリティを追加（`basic-block`, `input-contents`, `btn-wrapper` 等）

### 5) 運用面の下支え

- `.env.example` を追加し、GitHub認証に必要なenvの雛形を用意
- `.github/pull_request_template.md` を追加し、PR本文の記載ルール（実装したこと/動作確認など）をテンプレ化

## 追加/変更したファイル

- 追加
  - `.env.example`
  - `.github/pull_request_template.md`
  - `app/routes/api.collect.tsx`
  - `app/types/markdown-it-task-lists.d.ts`
- 変更
  - `app/services/github.server.ts`（Octokit + 認証切替 + PR/Review取得）
  - `app/routes.ts`（`api/collect` ルート追加）
  - `app/routes/_index.tsx`（Fetch UI + Markdownレンダリング表示 + Parse導線整理）
  - `app/app.css`（入力/ボタン/Markdown表示の最低限スタイル）
  - `package.json` / `package-lock.json`（依存追加）

## 依存追加

- `octokit`, `@octokit/auth-app`（GitHub REST API）
- `markdown-it`, `markdown-it-task-lists`, `@types/markdown-it`（Markdown表示）

## 動作確認

1. `npm install`
2. `.env` を作成し `GITHUB_TOKEN`（または `GITHUB_PAT`）を設定
3. `npm run dev`
4. ブラウザで `/` を開く
5. owner/repo/prNumber を入力して「Get Description」
6. Descriptionがレンダリング表示されることを確認
7. 「Parse Checklist」でチェックリスト解析結果が表示されることを確認

## 非スコープ（このPRではやっていない）

- OneDrive（Microsoft Graph）への保存
- Markdown→保存用HTMLの生成（CSS同梱、画像DL等）
- JSONアーティファクトのダウンロード機能
- `hasApproved` の厳密化（最新レビュー状態の集約など）

## メモ / リスク

- Markdown表示は `dangerouslySetInnerHTML` を使用しているが、`markdown-it` 側で `html: false` としており、Markdown内の生HTMLは無効化している（安全寄り）。
- `hasApproved` は「APPROVEDが1件でもある」簡易判定。要件が固まり次第、最新状態の集約に切替予定。

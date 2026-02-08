# 要件定義: PR Description Collector

## 背景 / 目的
- PR description（= GitHub PR の `body`、Markdown 形式）に含まれるチェックリストを解析し、各項目の状態を可視化する。 
- レビューの完了時に PR description 全体とエビデンス画像を保存し、レビュー証跡を残すことでチーム開発の円滑化を図る

## 利用者 / 想定ユースケース
- レビュアー: コード、チェックリストのレビュー完了後 PR description の中にあるチェックリストとエビデンス画像を保存する

## スコープ
### 対象範囲（In Scope）
- Markdown のチェックリスト（`- [ ]` / `- [x]` / `* [ ]` / `1. [x]` など）を解析する。 
- ブラウザでマークダウンファイルと同様の形でテキストが表示される 
- レビュー完了後、保存ボタンを押すと PR description を JSON として保存し、画像と合わせて OneDrive に保存する。 
- 入力は `Get Description` ボタン押下時に GitHub API 経由で取得する。取得対象は PR の JSON 本体。 
- 入力フォームで `owner` / `repo` / `prNumber` を指定する。将来的に GitHub OAuth 採用時は `owner` の入力を変更する可能性がある。 

### 非対象範囲（Out of Scope）
- GitHub 以外の PR API（GitLab 等）との連携や自動取得。  
- 複数 PR の履歴検索・共有。 
- GitHub 上での進捗管理やレビュー時のチャット。 

## 機能要件
1. **チェックリスト解析**
   - Json本体は GitHub API から取得する PR の JSON 本体。 
   - PR description は JSON 内の Markdown 形式テキストを対象とする（`body`）。 
   - `- [ ]`, `- [x]`, `* [ ]`, `1. [x]` 形式のリスト項目を検出する。
   - `x` / `X` のチェックを完了として扱う。
   - 各項目について以下を返す: 
     - `checked`: 完了かどうか 
     - `text`: チェックボックス後のテキスト（前後空白は除去） 
     - `line`: 入力内の行番号（1 始まり） 

2. **UI 表示**
   - ボタン押下後、ボタン配置箇所の下部に PR description を表示
   - `Get Description` 実行時に JSON 取得エラーが発生した場合は、ボタン直下にエラーメッセージを表示する。
   - エラーメッセージはレスポンスコードに応じて出し分ける（例: 400/401/403/404/429/500）。
   - PR description の下部に「チェックリスト項目」「エビデンス画像」「チェックリストの結果コメント」をカード形式でまとめて表示
   - レスポンシブ対応(Android, iPhone, iPad mini, iPad, iPad pro, PC）

3. **アーカイブ保存**
   - レビュー完了後のタイミングで、PR description の JSON と画像を OneDrive に保存する。 
   - 保存する JSON には保存者の `login`（レビュアーか PL を想定）、保存日時（`archivedAt`、日本時間のシステム時刻）、PR description（`body`）、チェックリスト解析結果を含める。
   - 保存する JSON は PR JSON から必要なフィールドのみを抽出して生成する。
   - 画像は PR description 内の HTML `img` タグと Markdown 画像の両方をパースしダウンロードする。
   - 画像取得に失敗した場合はエラーメッセージを表示する。
   - OneDrive の保存先フォルダは人力で「プロジェクト名/チェックリスト」を作成し、アプリ側ではフォルダ作成や最適化は行わない。

## 非機能要件
- **速度**: 数十〜数百行程度の入力で即時に解析できる。 
- **可用性**: ローカル環境で動作（Remix の SSR を前提）。 
- **可読性**: UI は最小限でも、結果の視認性（チェック状態・行番号）が確保される。 
- **保管性**: OneDrive 上に JSON と画像が保存されること。 

## 入出力仕様
### 入力
- 入力フォームで `owner` / `repo` / `prNumber` を受け取る。`Get Description` ボタン押下時に GitHub API から PR の JSON を取得する。 
- 入力バリデーションは GitHub のリポジトリ入力ルールに準拠し、`prNumber` は数字のみを許容する。
- バリデーションエラーはフロントエンド/バックエンドの両方で検知する。

### 出力
- UI→プルリクエストの description、チェックリストとエビデンスのカード 
- ファイル→OneDrive に保存する JSON と画像。 

## 受け入れ基準
- レビュー完了後、PR description の JSON と画像が OneDrive に保存される。 

## 既存実装との対応
- 解析処理は `Get Description` で行う。
- チェックリストカードの表示は`Parse Checklist`
- `Index` ルートでフォーム入力と結果表示を行う。 

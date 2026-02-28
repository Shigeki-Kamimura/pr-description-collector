# 要件定義: PR Description Collector

## 背景 / 目的
- PR description（= GitHub PR の `body`、Markdown 形式）に含まれるチェックリストを解析し、各項目の状態を可視化する。 
- レビューの完了時に PR description 全体とエビデンス画像を保存し、レビュー証跡を残すことでチーム開発の円滑化を図る

## 利用者 / 想定ユースケース
- レビュアー: コード、チェックリストのレビュー完了後 PR description の中にあるチェックリストとエビデンス画像を保存する

## スコープ
### 対象範囲（In Scope）
- Markdown のチェックリスト（`- [ ]` / `- [x]` / `* [ ]` / `1. [x]` など）を解析する。 
- ブラウザで Markdown ファイルと同様の見た目でテキストが表示される。 
- レビュー完了後、保存ボタンを押すと PR description を JSON として保存し、画像と合わせて OneDrive に保存する。 
- 入力は `Get Description` ボタン押下時に GitHub API 経由で取得する。取得対象は PR の JSON 本体。 
- 入力フォームで `owner` / `repo` / `prNumber` を指定する。将来的に GitHub OAuth 採用時は `owner` の入力を変更する可能性がある。 

### 非対象範囲（Out of Scope）
- GitHub 以外の PR API（GitLab 等）との連携や自動取得。  
- 複数 PR の履歴検索・共有。 
- GitHub 上での進捗管理やレビュー時のチャット。 

## 機能要件
1. **チェックリスト解析**
   - JSON 本体は GitHub API から取得する PR の JSON 本体。 
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
   - 「チェックリストの結果コメント」は任意入力は提供せず、PR description 内の `Result:` 行から抽出して表示する。
   - エビデンス画像の不備や動作テスト結果の相違に関するやり取りは、本アプリ内では行わない。
   - 指摘や調整は PR のコメント / Slack で行い、本アプリの画面キャプチャを共有して伝達する運用を推奨する。
   - レスポンシブ対応（Android, iPhone, iPad mini, iPad, iPad Pro, PC）
   - 保存済みエビデンス画像はアプリ内 API（`/api/onedrive/evidence-image`）経由で表示する。
   - 画像表示エラー要件（カード単位で処理し、チェックリスト本文と Result 表示は継続する）:
     - `400`: 画像パス不正。画像表示領域は「エビデンス画像なし」を表示する。
     - `401`: OneDrive 認証エラー。再認証を促すメッセージ種別を表示する。
     - `403`: OneDrive 権限不足。権限不足メッセージ種別を表示する（401 と区別する）。
     - `404`: 保存済み画像なし。画像表示領域は「エビデンス画像なし」を表示する。
     - `415`: 画像以外のコンテンツ。画像表示領域は「エビデンス画像なし」を表示する。
     - `429`: レート制限。自動リトライは行わず、待機後の再試行を促すメッセージ種別を表示する。
     - `5xx` / timeout: 一時障害。再試行を促すメッセージ種別を表示する。
   - フォールバック表示要件:
     - 保存済み画像の表示に失敗した場合は、PR description から抽出した未保存プレビュー URL にフォールバックする。
     - 未保存プレビュー表示時のみ「未保存プレビュー」ラベルを表示する。
     - 未保存プレビューも表示できない場合は「エビデンス画像なし」を表示する。
   - セキュリティ要件（画像表示 API）:
     - `path` は許可フォルダ配下（`/<work>/<project>/.../PullRequests/.../imgs/...`）のみ許容する。
     - `token`（サーバー署名）を必須とし、`path` と `token` の組み合わせが検証できない場合は画像を返さない。
     - 画像レスポンスには `X-Content-Type-Options: nosniff` を付与する。
   - 表示フォールバック要件（GitHub 取得失敗時）:
     - GitHub API から PR にアクセスできないすべてのエラーコード（`4xx/5xx` およびネットワーク系失敗）で PR 取得に失敗しても、OneDrive 上の `archive.json` と `imgs` が整合していれば、保存済みアーカイブを基にチェックリストカード表示を継続する。
     - このフォールバックは表示専用とし、保存処理の認証要件（OneDrive セッション有効性確認）は維持する。
     - `archive.json` の破損または `archive.json` と `imgs` の不整合がある場合は、フォールバック表示せずエラーを表示する。
     - OneDrive 上に同じ `prNumber` の保存フォルダ（`PR<prNumber>-*`）が複数存在する場合は、表示対象を自動選択せず、競合エラーとしてユーザーに整理を促す。
     - 上記フォールバック失敗時のダイアログ見出しは「表示」文脈として扱う。

3. **アーカイブ保存**
   - レビュー完了後のタイミングで、アーカイブ用 JSON（アプリ独自スキーマ）と画像を OneDrive に保存する。 
   - アーカイブ用 JSON には保存者の `login`（レビュアーか PL を想定）、保存日時（`archivedAt`、日本時間のシステム時刻）、PR description（`body`）、チェックリスト解析結果を含める。
   - `archivedAt` は ISO 8601 形式（例: `2026-02-08T12:34:56+09:00`）で保存する。
   - アーカイブ用 JSON は PR JSON から必要なフィールドのみを抽出して生成する（生の PR JSON は保存しない）。
   - 画像は PR description 内の HTML `img` タグと Markdown 画像の両方をパースしダウンロードする。
   - 画像取得に失敗した場合はエラーメッセージを表示する。
   - 保存先のフォルダ構成は以下とする。
   - `ONEDRIVE_WORK_FOLDER` が設定されている場合: `/<work>/<project>/<repo>/PullRequests/PR<prNumber>-<prTitle>/`
   - `ONEDRIVE_WORK_FOLDER` が未設定の場合: `/<project>/<repo>/PullRequests/PR<prNumber>-<prTitle>/`
   - JSON: 上記フォルダ配下に `archive.json` を保存する。
   - 画像: 上記フォルダ配下の `imgs/` に保存する。
   - `prTitle` は日本語を保持し、OneDrive/Windows で使用できない文字のみ除外する。
   - `prTitle` はフォルダ名として最大 80 文字に切り詰める。
   - ファイル名は、JSON は `archive.json` 固定とし、画像はソースURL由来のファイル名を優先して保存する（拡張子は取得した画像に準拠）。
   - 同名衝突時はサフィックス（`-1`, `-2`, ...）を付与して一意化する。
   - 画像の再参照性を高めるため、アーカイブ用 JSON に画像の対応情報を含める（例: `evidenceImages` に `index` / `savedFilename` / `originalFilename` / `sourceUrl`）。
   - 画像の重複保存制御:
     - `sourceUrl` が同一で、かつ `archive.json` の成功レコードに対応する実体画像（`onedrivePath`）が存在する場合のみ「保存済み」として再保存をスキップする。
     - `archive.json` に成功レコードがあっても、`onedrivePath` が欠落している、または実体画像が存在しない場合は再保存対象とする。
   - 画像欠落復旧:
     - `archive.json` と `description.md` が保存済みでも、`imgs/` 配下の実体画像が消失している場合は、次回保存時に画像を再ダウンロードして再保存する。
   - 画像保存の整合性:
     - 画像保存判定は `archive.json` の記録だけで完結させず、OneDrive 上の実体画像の存在確認を必須とする。
   - 本アプリでのユーザー操作は「フォルダ作成」と「ファイル移動」のみとし、画像単体を閲覧する UI は提供しない。
   - OneDrive ルートに一時保存して人力で移動する運用を想定する。自動化する場合はアプリ側でフォルダ作成と移動を行う（無ければ作成）。自動化の有無は設定で切り替え可能とする。
   - アーカイブ用 JSON の最小スキーマ例（JSON）:
     ```json
     {
       "prNumber": 1,
       "prTitle": "PRtitle",
       "repoOwner": "octo-org",
       "repoName": "example-repo",
       "prUrl": "https://github.com/octo-org/example-repo/pull/1",
       "prAuthor": "octocat",
       "mergedBy": "merger1",
       "reviewer": "reviewer1",
       "archivedBy": "reviewer1",
       "body": "PR description の本文...",
       "archivedAt": "2026-02-08T12:34:56+09:00",
       "archivedAtUtc": "2026-02-08T03:34:56Z"
     }
     ```
   - 各項目の意味:
     - `prNumber`: プルリクエスト番号
     - `prTitle`: プルリクエストタイトル
     - `repoOwner`: リポジトリの owner
     - `repoName`: リポジトリ名
     - `prUrl`: プルリクエストの URL
     - `prAuthor`: プルリクエストを出したユーザー
     - `mergedBy`: プルリクエストをマージしたユーザー
     - `reviewer`: レビュアー
     - `archivedBy`: 保存したユーザー
     - `body`: ディスクリプション本文
     - `archivedAt`: 保存日時（日本時間）
     - `archivedAtUtc`: 保存日時（UTC）
   - `archivedBy` は OneDrive の `/me` 情報から取得する。
   - `/me` から保存実行者を特定できない場合（`userPrincipalName` / `displayName` ともに取得不可）は、監査性を優先して保存処理を中止し、エラーとして扱う。
   - 保存処理の開始前に `/me/drive` で OneDrive セッションの有効性を検証し、未認証時は保存処理を実行しない。

## 非機能要件
- **速度**: 数十〜数百行程度の入力で即時に解析できる。 
- **可用性**: ローカル環境で動作（Remix の SSR を前提）。 
- **可読性**: UI は最小限でも、結果の視認性（チェック状態・行番号）が確保される。 
- **保管性**: OneDrive 上に JSON と画像が保存されること。 

## 入出力仕様
### 入力
- 入力フォームで `owner` / `repo` / `prNumber` を受け取る。`Get Description` ボタン押下時に GitHub API から PR の JSON を取得する。 
- 入力バリデーション要件（フロントエンド / バックエンド共通）:
  - `owner`（GitHub user / org 名）:
    - 許容文字: 英数字 (`A-Z` / `a-z` / `0-9`) とハイフン (`-`) のみ。
    - 先頭および末尾にハイフンを置くことは不可。
    - 長さ: 1〜39 文字。
    - 実装指針としての例: 正規表現 `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$` にマッチする文字列のみ許容する。
    - 参考: GitHub Docs のユーザ名/Organization 名制約（例: <https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-github-user-account/managing-your-profile-settings/changing-your-github-username>）に準拠すること。
  - `repo`（リポジトリ名）:
    - 許容文字: 英数字 (`A-Z` / `a-z` / `0-9`)、ハイフン (`-`)、アンダースコア (`_`)、ドット (`.`)。
    - 空文字は不可。
    - 長さ: 1〜100 文字。
    - 実装指針としての例: 正規表現 `^[A-Za-z0-9._-]{1,100}$` にマッチする文字列のみ許容する。
  - `prNumber`:
    - 数字のみを許容する。
    - 0 および空文字は不可とし、1 以上の整数のみ許容する。
    - 実装指針としての例: 正規表現 `^[1-9][0-9]*$` にマッチする文字列のみ許容する。
  - バリデーションはフロントエンド / バックエンドの両方で同一ルールに基づき実施し、一方のみ通過する状態を許容しない。
- バックエンド側の最終的な拒否条件（GitHub API 応答ベース）:
  - GitHub API から `404 Not Found` が返却された場合:
    - `owner` / `repo` / `prNumber` の組み合わせに該当する PR が存在しないものとして扱い、「リポジトリまたは PR が存在しません」といった種別のバリデーションエラーとして UI に通知する。
    - PR description の取得・保存処理は行わないが、表示については「保存済みアーカイブ表示フォールバック要件」を優先する。
  - `401 Unauthorized` または `403 Forbidden` が返却された場合:
    - 認証または権限不足エラーとして扱い、ユーザーには「認証情報または権限に問題があります」といったメッセージ種別で通知する（トークン値などの内部情報は表示しない）。
    - PR description の取得・保存処理は行わないが、表示については「保存済みアーカイブ表示フォールバック要件」を優先する。
  - `5xx` 系のレスポンスやネットワークエラーの場合:
    - 一時的な外部サービス障害として扱い、「GitHub API への接続に失敗しました。しばらくしてから再実行してください」といったリトライ前提のエラーとして UI に通知する。
    - PR description の取得・保存処理は行わないが、表示については「保存済みアーカイブ表示フォールバック要件」を優先する。
  - OneDrive フォールバック時に `PR<prNumber>-*` フォルダが複数見つかった場合:
    - 誤ったアーカイブを表示しないため、自動選択は行わず競合エラーとして UI に通知する。
    - ユーザーには不要な保存フォルダの整理を促す。
### 出力
- UI → PR description、チェックリストとエビデンスのカード 
- ファイル → OneDrive に保存する JSON と画像。 

## 受け入れ基準
- レビュー完了後、PR description の JSON と画像が OneDrive に保存される。 

## 既存実装との対応
- 解析処理は `Get Description` で行う。
- チェックリストカードの表示は `Parse Checklist`
- `Index` ルートでフォーム入力と結果表示を行う。 

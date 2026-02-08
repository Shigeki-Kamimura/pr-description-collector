# Checklist Generation Rules

目的: PR description に貼るチェックリストを、AI/人が一貫した形式で生成できるようにする。

## 必須フォーマット
- セクション見出しは `###` で始める。
- `### Scope:` の後に続く文字列は日本語にする。
- 各項目は次の形にする。
  - `- [ ] CHK-xx <項目名>`
  - `Result: <結果の短文>`
  - `Evidence: <URL or filename or N/A>`
- `CHK-xx` は 2 桁の連番（例: `CHK-01`）で付与する。
- 複数エビデンスが必要な場合は `Evidence:` に `, ` 区切りで並べる。

## チェック状態
- 達成済み: `- [x]`
- 未達: `- [ ]`

## 未達の書き方
- `Result:` に未達理由や次タスクを記載する。
- `Evidence:` は `N/A` にする。

## Out of Scope の書き方
- `Result:` は `非スコープ` とする。
- `Evidence:` は `N/A` にする。

## サンプル
```
- [x] CHK-01 Example item
  Result: 表示を確認
  Evidence: https://example.com/evidence.png

- [ ] CHK-02 Example item
  Result: 未達（次タスクで対応）
  Evidence: N/A
```

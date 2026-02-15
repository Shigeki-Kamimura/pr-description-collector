## プルリクエストディスクリプション内に書くチェックリストひな形

## チェックリスト

### Scope: チェックリスト小見出し（例: OneDrive Save）
- [ ] CHK-01 <項目名>
  Result: <調査結果>
  Evidence: <URL or filename or N/A>
- [ ] CHK-02 <項目名>
  Result: <調査結果>
  Evidence: <URL or filename or N/A>

### Scope: チェックリスト小見出し（例: Routing / Wiring）
- [ ] CHK-03 <項目名>
  Result: <調査結果>
  Evidence: <URL or filename or N/A>
- [ ] CHK-04 <項目名>
  Result: <調査結果>
  Evidence: <URL or filename or N/A>

### Scope: チェックリスト小見出し（例: Out of Scope）
- [ ] CHK-05 <項目名>
  Result: <調査結果>
  Evidence: 

## 使い方ルール
- `CHK-xx` は PR 全体で連番にする（Scope をまたいでも番号を振り直さない）
- `Result` は「確認した事実」を1文で書く
- `Evidence` は画像URL、PRコメントURL、ファイル名のいずれかを必ず入れる
- 非該当は `Evidence: N/A` ではなく、`Result` に `N/A: 理由` を書く

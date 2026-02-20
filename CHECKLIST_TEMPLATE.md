## プルリクエストディスクリプション内に書くチェックリストひな形

## チェックリスト

### Scope: チェックリスト小見出し（例: OneDrive Save）
- [ ] CHK-01 <項目名>
  Result: <調査結果>
  Evidence: 
- [ ] CHK-02 <項目名>
  Result: <調査結果>
  Evidence: 

### Scope: チェックリスト小見出し（例: Routing / Wiring）
- [ ] CHK-03 <項目名>
  Result: <調査結果>
  Evidence: 
- [ ] CHK-04 <項目名>
  Result: <調査結果>
  Evidence: 

### Scope: チェックリスト小見出し（例: Out of Scope）
- [ ] CHK-05 <項目名>
  Result: <調査結果>
  Evidence: 

## 使い方ルール
- `CHK-xx` は PR 全体で連番にする（Scope をまたいでも番号を振り直さない）
- `Result` は「確認した事実」を1文で書く
- `Evidence` は画像URL、PRコメントURL、ファイル名のいずれかを必ず入れる
- 非該当は `Evidence: N/A` ではなく、`Result` に `N/A: 理由` を書く

## 人間レビュー対応（最後に追記）
- 人間レビュー（スタッフ/シニア/レビュアー）完了後、以下のセクションをチェックリストの末尾へ追記する
- このセクションは `CHK-xx` を採番しない

### Scope: Review Operations / Evidence（Human Review）
- [ ] 重複指摘・既対応指摘への返信方針が反映されている
  Result: 「前回コミットで解決済みです」運用を適用した履歴を確認する
  Evidence:
- [ ] スタッフ/シニアレビューの指摘に対する採否判断と根拠が記録されている
  Result: 採用・不採用・保留が理由付きで残っていることを確認する
  Evidence:

### Scope: Out of Scope（Human Review）
- [ ] PR本文中画像の取得・`evidence-img/` 保存は未実装である
  Result: 本PRで未対応であることを明記し、追跡Issueと紐づける
  Evidence:

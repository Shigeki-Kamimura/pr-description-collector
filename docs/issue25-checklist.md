## チェックリスト

### Scope: 画像保存要件（Issue #25）
- [x] CHK-01 `evidenceImages.status` を `success|failed` に統一
  Result: Issue要件どおり、成功時ステータスを `success` へ修正しました。
  Evidence: `app/routes/api.onedrive.upload.tsx`, `app/routes/api.onedrive.upload.test.ts`
- [x] CHK-02 PR本文の画像URL抽出と重複排除
  Result: Markdown/HTML画像URLを抽出し、同一URLは1回のみ処理する実装になっています。
  Evidence: `app/services/evidence-images.server.ts`, `app/services/evidence-images.server.test.ts`
- [x] CHK-03 画像保存先と衝突回避ルールの実装
  Result: `imgs` 配下保存と同名衝突時の連番付与を実装しています。
  Evidence: `app/routes/api.onedrive.upload.tsx`, `app/services/onedrive.server.ts`
- [x] CHK-04 部分成功許容と失敗記録
  Result: 一部失敗時も処理継続し、`status=failed` と `errorReason` を記録します。
  Evidence: `app/routes/api.onedrive.upload.tsx`, `app/routes/api.onedrive.upload.test.ts`

### Scope: エラー処理・品質検証
- [x] CHK-05 OneDrive認証切れ時の中断
  Result: 認証エラーは中断し、再認証が必要なエラーとして返却します。
  Evidence: `app/routes/api.onedrive.upload.tsx`, `app/routes/api.onedrive.upload.test.ts`
- [x] CHK-06 タイムアウト/リトライ実装
  Result: 画像取得は 180秒タイムアウト・最大3回リトライを実装しています。
  Evidence: `app/services/evidence-images.server.ts`, `app/services/evidence-images.server.test.ts`
- [x] CHK-07 回帰テストと型検証
  Result: 変更範囲のテストおよび型チェックを実行し、通過を確認しました。
  Evidence: `npm run test`, `npm run typecheck`

### Scope: チェックリスト運用整合
- [x] CHK-08 チェックリスト定義の矛盾解消（不足あり2）
  Result: 未達/非スコープ時の `Evidence: N/A` ルールをテンプレへ反映し整合化しました。
  Evidence: `CHECKLIST_TEMPLATE.md`, `CHECKLIST_RULES.md`
- [ ] CHK-09 Human Review セクションの「画像未実装」文言更新（不足あり3）
  Result: 未達（次タスクで、実装済み状態に合わせて文言を更新する必要があります）。
  Evidence: N/A

### Scope: Out of Scope
- [ ] CHK-10 UI仕様・表示仕様の見直し
  Result: 非スコープ
  Evidence: N/A

### Scope: Review Operations / Evidence（Human Review）
- [ ] 重複指摘・既対応指摘への返信方針が反映されている
  Result: 人間レビュー未実施のため未確認です。
  Evidence: N/A
- [ ] スタッフ/シニアレビューの指摘に対する採否判断と根拠が記録されている
  Result: 人間レビュー未実施のため未確認です。
  Evidence: N/A

### Scope: Out of Scope（Human Review）
- [ ] 人間レビュー運用の実施ログ
  Result: 非スコープ
  Evidence: N/A

# Copilot Review Checklist

## 0. Review Mode
- [ ] MODE=FULL_SWEEP
- [ ] MODE=DIFF_ONLY
- [ ] MODE=L0_AUDIT
- [ ] MODE=BROWSER_FINAL

Rule:
- FULL_SWEEP: PR全体の Medium/High 本番リスクを一度で洗い出す
- DIFF_ONLY: 前回レビュー以降の変更差分だけを見る
- L0_AUDIT: 通常レビューはしない。CI/presubmit の抜けだけを見る
- BROWSER_FINAL: マージ可否に関わる未解決事項だけを見る

## 1. PR Type
- [ ] バグ修正
- [ ] 機能追加
- [ ] リファクタ
- [ ] インフラ / 設定
- [ ] スキーマ / SQL
- [ ] 認証 / 認可
- [ ] デプロイ / 運用

## 2. N/A Rule
- [ ] 非該当項目は `N/A: 理由` を1行で記載する
- [ ] 不明なら推測で埋めず、`Unknown: 要確認` とする

## 3. Scope Guard
- [ ] このPRの Objective は明確
- [ ] Non-goals が明確
- [ ] correctness が goal / non-goal の曖昧さに依存する場合は、1問だけ確認して停止
- [ ] 未変更箇所を新規に掘り返していない（DIFF_ONLY 時は必須）

## 4. Core Risk Gate（全モード共通）
- [ ] 本番障害の具体的シナリオが説明できる
- [ ] 影響範囲（ユーザー / データ / 運用）が説明できる
- [ ] 根本原因単位に統合されている
- [ ] 推測だけの指摘ではない
- [ ] Low / cosmetic を混ぜていない

## 5. Security / Boundary
確認するのは「本番障害に直結するもの」のみ
- [ ] 認証 / 認可の欠落や迂回がない
- [ ] 入力検証 / サニタイズ不足がない
- [ ] secrets / PII がログやエラーに漏れない
- [ ] trust boundary をまたぐ箇所に危険な前提がない

## 6. Correctness / Error Path
- [ ] ロジックバグがない
- [ ] null / empty / boundary の壊れ方がない
- [ ] error path が握りつぶされていない
- [ ] state transition が壊れていない
- [ ] public contract の破壊がない

## 7. Data Integrity
変更が永続化やDBに触れるときだけ確認
- [ ] 重複書き込み / lost update のリスクがない
- [ ] 部分更新で不整合が起きない
- [ ] transaction boundary が不足していない
- [ ] idempotency が必要な箇所で崩れていない

## 8. Reliability / Concurrency
該当変更のときだけ確認
- [ ] retry / timeout / cancellation で correctness が壊れない
- [ ] race / deadlock / resource leak の実害がない
- [ ] 外部依存失敗時の振る舞いが危険でない

## 9. Minimal Test / Check
- [ ] 高リスク契約を固定する最小の test/check がある
- [ ] coverage 目標ではなく「今回の failure path を閉じる最小チェック」になっている
- [ ] L0で拾えるならL0へ、拾えないなら追加最小テストを提案する

## 10. L0_AUDIT Only
このセクションは MODE=L0_AUDIT のときだけ使う
- [ ] lint/type/test/build/security のどのゲートが存在するか把握した
- [ ] 実害があるのに CI で素通りするパスがある
- [ ] 追加すべき gate は最小限（1〜3件）
- [ ] “missing gate / weak gate / missing regression test” の形式で整理した

## 11. DIFF_ONLY Only
このセクションは MODE=DIFF_ONLY のときだけ使う
- [ ] 未変更ファイルを新規に指摘していない
- [ ] 既報の指摘を繰り返していない
- [ ] 今回の差分が悪化させた問題だけを見ている
- [ ] 新規に残る Medium/High がなければ明確に「なし」と言う

## 12. BROWSER_FINAL Only
このセクションは MODE=BROWSER_FINAL のときだけ使う
- [ ] マージ阻害レベルの論点だけに絞った
- [ ] 1 root cause = 1 finding で重複統合した
- [ ] 5件以内に収まるよう統合した
- [ ] 可能な限り最終パスとして完結している

## 13. Specialist Add-ons（必要時のみ）
### SQL / Schema
- [ ] クエリ / スキーマ変更が correctness や data integrity を壊さない
- [ ] インデックス / 制約 / rollback を考慮している
- [ ] explain や性能議論は、実害がある場合だけ要求する

### Deployment / Rollout
- [ ] rollout / rollback が必要な変更か判断した
- [ ] 不可逆変更なら停止条件が明確
- [ ] feature flag / migration 順序 / recovery を確認した

### Docs / API
- [ ] public API や運用手順が変わるなら必要最小限の文書更新がある
- [ ] それ以外は docs 不足を原則指摘しない

## 14. Output Shape Check
各 finding は次だけを含む
- [ ] Location
- [ ] Failure scenario
- [ ] Impact
- [ ] Minimal fix
- [ ] Minimal test/check（必要時のみ）

## 15. Final Decision
- [ ] Medium/High の本番リスクあり
- [ ] Medium/High の本番リスクなし
- [ ] Goal / Non-goal が曖昧で停止

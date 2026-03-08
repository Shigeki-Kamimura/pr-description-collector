# Copilot Review Checklist

## 0. MODE
- [ ] FULL_SWEEP_L2PLUS
- [ ] DIFF_ONLY_L2PLUS
- [ ] L0_AUDIT
- [ ] BROWSER_FINAL

Rule:
- FULL_SWEEP_L2PLUS: PR全体の L2+ Medium/High を洗う
- DIFF_ONLY_L2PLUS: 前回以降の差分だけを見る
- L0_AUDIT: 通常レビューはしない。L0の抜けだけ見る
- BROWSER_FINAL: PR時点でまだ拾う価値がある Medium/High だけ確認

## 1. PR Type
- [ ] バグ修正
- [ ] 機能追加
- [ ] リファクタ
- [ ] 認証 / 認可
- [ ] スキーマ / SQL
- [ ] インフラ / 設定
- [ ] デプロイ / 運用

## 2. N/A / Unknown
- [ ] 非該当は `N/A: 理由`
- [ ] 不明は `Unknown: 要確認`
- [ ] 推測で埋めない

## 3. Scope Guard
- [ ] Objective が明確
- [ ] Non-goals が明確
- [ ] goal / non-goal が曖昧で correctness に効くなら 1問だけ確認して停止
- [ ] DIFF_ONLY では未変更箇所を新規に掘り返していない

## 4. Core Risk Gate
- [ ] 本番障害の具体的シナリオを説明できる
- [ ] ユーザー / データ / 運用への影響を説明できる
- [ ] コード上の根拠がある
- [ ] root cause 単位に統合されている
- [ ] Low / cosmetic を混ぜていない

## 5. L2+ Focus
### Contract / State
- [ ] public contract の破壊がない
- [ ] state transition が壊れていない
- [ ] error path が危険でない

### Security / Boundary
- [ ] 認証 / 認可の欠落や迂回がない
- [ ] trust boundary をまたぐ前提が危険でない
- [ ] 入力検証 / secrets / PII の扱いに実害がない

### Data Integrity
- [ ] duplicate write / lost update / partial write がない
- [ ] transaction boundary が不足していない
- [ ] idempotency が崩れていない

### Reliability / Concurrency
- [ ] retry / timeout / cancellation で correctness が壊れない
- [ ] race / deadlock / resource leak の実害がない
- [ ] 外部依存失敗時の振る舞いが危険でない

### Persistence / SQL
- [ ] 永続化仕様が contract と矛盾しない
- [ ] schema / query 変更が correctness や整合性を壊さない
- [ ] migration / rollback の破綻がない

### Rollout / Deployment
- [ ] rollout / rollback 手順が必要な変更か判断した
- [ ] 不可逆変更の停止条件がある
- [ ] feature flag / migration 順序 / recovery を確認した

## 6. Minimal Test / Check
- [ ] failure path を閉じる最小 test/check がある
- [ ] coverage 目標ではなく、今回の高リスク契約を固定するチェックになっている
- [ ] L0で拾えるならL0へ、拾えないなら最小追加テストを提案

## 7. Mode-only
### L0_AUDIT
- [ ] lint / type / test / build / security のどこが抜けているか明確
- [ ] “missing gate / weak gate / missing regression test” で整理した
- [ ] 追加提案は 1〜3件に絞った

### DIFF_ONLY_L2PLUS
- [ ] 既報の指摘を繰り返していない
- [ ] 今回の差分が悪化させた問題だけを見ている
- [ ] 新規 Medium/High がなければ明確に「なし」と言う

### BROWSER_FINAL
- [ ] root cause ごとに統合した
- [ ] 5件以内
- [ ] PR時点で拾う価値がある残件だけ
- [ ] 広い再探索ではなく取りこぼし確認になっている

## 8. Output Shape
各 finding は次だけを含む:
- [ ] Location
- [ ] Failure scenario
- [ ] Impact
- [ ] Minimal fix
- [ ] Minimal test/check（必要時のみ）

## 9. Final Decision
- [ ] Medium/High の本番リスクあり
- [ ] Medium/High の本番リスクなし
- [ ] Goal / Non-goal が曖昧で停止

## Summary（必須）
- 何を変えたか:
- なぜ（背景/狙い）:
- Touch / Do NOT touch:
  - Touch:
  - Do NOT touch:

## Acceptance（Must）（必須）
- [ ] （例）XXのときYYになる
- [ ] （例）エラーパスはZZを返す

## Invariants（必須）
- （例）金額は最小通貨単位の整数、負にならない
- （例）認可なしで他ユーザーの資源にアクセスできない

## Deferred / Non-goals（任意）
- 

## Validation（必須）
- Commands to run（提案）:
  - [ ] （例）`npm test`
  - [ ] （例）`npm run lint`
- Commands run（Human）:
  - `...` ✅/❌（必要ならログ末尾10〜30行を貼る）
- Smoke check（UI/手動が必要な場合のみ）:
  - [ ] （例）通常系: `Get Description` → `Save to OneDrive` で `description.md` / `archive.json` を保存できる
  - [ ] （例）異常系: OneDrive認証失効時は `401` で停止し、保存処理が実行されない

## Evidence（必須）
- Logs:
  - `cmd` → ✅/❌（tail貼付 or リンク）
- Screenshots:
  - Image 1: （何の証跡か1行）
  - Image 2: （何の証跡か1行）

## Contracts changed（変更がある場合）
- API:
- DB / migration:
- Events / jobs:
- Types / schemas:

## Security / Trust Boundary（変更がある場合）
- 認証:
- 認可:
- 外部入力:
- 機微情報（PII / secrets / logs）:

## Risk / Rollback（大きい変更は必須）
- 影響範囲:
- 失敗時の戻し方:
- 互換性:

## Links（任意）
- Issue:
- PR:

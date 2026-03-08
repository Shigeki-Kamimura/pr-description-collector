# OneDrive OAuth Key Rotation Runbook

## 目的
- OneDrive OAuth token 暗号鍵ローテーション時の運用事故（全セッション無声失効）を防ぐ。
- ローリングデプロイ/ロールバック時の再認証影響を事前に把握して判断できるようにする。

## 前提
- 現行仕様は `current + previous(1世代)` のみサポートする。
- 新規保存は `current` 鍵で実施される。
- `previous` が未設定で `current != k1` の場合は、既定で起動時エラーとなる。
- 意図的に全セッション失効する場合のみ `ONEDRIVE_TOKEN_ENCRYPTION_ALLOW_SESSION_INVALIDATION=true` を使う。

## 必須チェック（実施前）
1. `ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_VERSION` が想定どおりか確認する。
2. `ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_MATERIAL` が想定どおりか確認する。
3. `ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION` に直前の current version を設定したか確認する。
4. `ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_MATERIAL` に直前の current material を設定したか確認する。
5. `current` と `previous` の version が同一でないことを確認する。
6. `keyVersion` に許可外文字（`.` 空白 `/` など）が入っていないことを確認する。
7. `ONEDRIVE_TOKEN_ENCRYPTION_ALLOW_SESSION_INVALIDATION` は `false`（または未設定）であることを確認する。

## 推奨デプロイ方式
- 保存形式互換の差があるリリースでは、blue/green の一括切替を優先する。
- ローリングデプロイを使う場合は、混在期間に一部再認証が発生し得ることを事前告知する。

## ローテーション手順
1. 直前の current を previous として設定する。
2. 新しい current version/material を設定する。
3. デプロイする（推奨: blue/green）。
4. デプロイ直後に警告ログを確認する。
   - `unknown-key-version`
   - `invalid-segment-count`
5. しきい値を超過したら、設定ミスまたはデプロイ互換性問題として即時調査する。

## ロールバック方針
- 旧バージョンが新形式トークン（5-segment）を復号できない場合、ロールバック後に再認証が発生する。
- ロールバック判断時は「OneDrive 再認証が必要になる可能性」を前提情報として扱う。
- 必要なら影響時間帯を限定し、ユーザー告知を先行する。

## 意図的な全セッション失効が必要な場合
1. `ONEDRIVE_TOKEN_ENCRYPTION_ALLOW_SESSION_INVALIDATION=true` を明示設定する。
2. 失効の目的と実施時刻を運用記録に残す。
3. 実施後、再認証案内をユーザーへ告知する。
4. デプロイ完了後、`ONEDRIVE_TOKEN_ENCRYPTION_ALLOW_SESSION_INVALIDATION` を
   unset または `false` に戻す（次回ローテーション時の誤バイパス防止）。

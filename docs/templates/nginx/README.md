# Nginx Dev HTTPS Template

このディレクトリは、ローカル開発で `HTTPS(公開)` + `HTTP(upstream)` を分離するための再利用テンプレートです。

## 置き場所の推奨

- 推奨: `docs/templates/nginx/`
- 非推奨: `.github/`

`.github/` は GitHub Actions や Issue/PR テンプレート用途のため、ランタイム設定ファイルは `docs/templates/` 配下に置く方が意図が明確です。

## ファイル

- `dev-https-reverse-proxy.conf.example`
  - 開発用 Nginx 設定テンプレート
  - Remix / React Router / Next.js + Vite 開発時の OAuth/CSRF/Host 正規化を想定

## 使い方

1. `__PUBLIC_PORT__` などのプレースホルダを実値に置換
2. `ssl_certificate` / `ssl_certificate_key` を実ファイルへ変更
3. Nginx の `http {}` 配下で include して有効化

## 補足

- このテンプレートは開発用です。本番用 TLS 設定（HSTS など）は別途定義してください。

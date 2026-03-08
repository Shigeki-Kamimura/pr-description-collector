# Welcome to React Router!

A modern, production-ready template for building full-stack React applications using React Router.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/remix-run/react-router-templates/tree/main/default)

## Features

- 🚀 Server-side rendering
- ⚡️ Hot Module Replacement (HMR)
- 📦 Asset bundling and optimization
- 🔄 Data loading and mutations
- 🔒 TypeScript by default
- 📖 [React Router docs](https://reactrouter.com/)

## Getting Started

## Environment Variables

- GitHub: `GITHUB_TOKEN`（または `GITHUB_PAT` / `GITHUB_APP_*`）
- OneDrive: `ONEDRIVE_ACCESS_TOKEN`（開発用・`/me/drive` を操作できるトークン）
- OneDrive OAuth（サーバーサイド）: `ONEDRIVE_TENANT` / `ONEDRIVE_CLIENT_ID` / `ONEDRIVE_CLIENT_SECRET` / `ONEDRIVE_REDIRECT_URI`
- OneDrive OAuth token store: `REDIS_URL`（必須）/ `REDIS_TIMEOUT_MS`（任意）
- OneDrive 保存先: `ONEDRIVE_BASE_FOLDER`（任意）/ `ONEDRIVE_WORK_FOLDER`（任意）
- `SESSION_SECRET` は production で必須（development 未設定時は固定フォールバックあり、明示設定推奨）
- 開発サーバー: `DEV_SERVER_HOST` / `DEV_SERVER_PORT`（ViteはHTTPで待受。利用者アクセスはHTTPS終端を必須とする）
- 例: [.env.example](.env.example)

### OneDrive OAuth Token Store

- OneDrive OAuth のサーバー側セッションは Redis を必須とします。
- `REDIS_URL` 未設定または Redis 障害時は、OAuth login / callback / セッション参照 / token refresh は `503` で fail-closed になります。
- Redis 障害は認証切れとして扱わず、一時的なシステム障害として返します。

### Installation

Install the dependencies:

```bash
npm install
```

### Development

Start the development server with HMR:

```bash
npm run dev
```

Your application will be available at:

- `https://localhost:5173`（開発時の必須入口）
- `http://localhost:5173` は非サポート（OAuthフロー対象外）

### Development with Nginx HTTPS (Required)
### NginxでHTTPS終端する開発手順（必須）

Use Nginx as HTTPS entrypoint and keep Vite on HTTP:
NginxをHTTPS入口にして、ViteはHTTPで起動します。

```env
# .env
DEV_SERVER_HOST=127.0.0.1
DEV_SERVER_PORT=5174
ONEDRIVE_REDIRECT_URI=https://localhost:5173/auth/onedrive/callback
ONEDRIVE_TRUST_X_FORWARDED_PROTO=true
# optional: customize trusted proxy hosts when needed
# ONEDRIVE_TRUSTED_PROXY_HOSTS=localhost:5173,127.0.0.1:5173
# optional: require proxy shared secret when trusting forwarded headers
# ONEDRIVE_TRUST_PROXY_SHARED_SECRET=change-this
```

`ONEDRIVE_TRUST_X_FORWARDED_PROTO=true` is required for the Nginx HTTPS-termination setup above, because
the app receives upstream HTTP while external access is HTTPS.
If `ONEDRIVE_TRUST_PROXY_SHARED_SECRET` is set, the app also requires
`x-onedrive-proxy-secret` to match before trusting `X-Forwarded-*` headers.

Nginx config template:
Nginx設定テンプレート:

- `docs/vite-dev-https.conf.example`

Setup steps:
セットアップ手順:

1. Prepare your own PEM files (certificate and private key).
1. PEMファイル（証明書と秘密鍵）を各自で用意する。
2. Copy the template:
2. テンプレートを配置する:

```bash
sudo cp docs/vite-dev-https.conf.example /etc/nginx/sites-available/vite-dev-https
```

3. `/etc/nginx/sites-available/vite-dev-https` 内の証明書パスを実ファイルに合わせて修正する。
4. サイトを有効化し、Nginxを再読込する:

```bash
sudo ln -sfn /etc/nginx/sites-available/vite-dev-https /etc/nginx/sites-enabled/vite-dev-https
sudo nginx -t
sudo systemctl reload nginx
```

5. アプリサーバー（Vite）を起動する:

```bash
npm run dev
```

Access always from:
アクセス先は常に以下に統一:

- `https://localhost:5173`

## Building for Production

Create a production build:

```bash
npm run build
```

## Deployment

### Docker Deployment

ローカル開発は `npm run dev`（Vite/React Router dev server）を前提とします。
Docker イメージは HMR 用ではなく、production build を配布・起動するためのものです。

Build and run the production container:

```bash
docker build -t pr-description-collector .

# Run the container
docker run \
  -e SESSION_SECRET=replace-with-a-long-random-secret \
  -p 3000:3000 \
  pr-description-collector
```

Notes:

- `SESSION_SECRET` は production で必須です。
- OneDrive OAuth を使う場合は `REDIS_URL` が必須です。
- `http://localhost:3000` への直アクセスは、コンテナの疎通確認用です。
- ブラウザでの実運用確認や OneDrive OAuth は、HTTPS 終端された入口（Nginx / ingress / load balancer）配下で行ってください。
- コンテナには `/api/health` を見る `HEALTHCHECK` を設定しています。

The containerized application can be deployed to any platform that supports Docker, including:

- AWS ECS
- Google Cloud Run
- Azure Container Apps
- Digital Ocean App Platform
- Fly.io
- Railway

### DIY Deployment

If you're familiar with deploying Node applications, the built-in app server is production-ready.

Make sure to deploy the output of `npm run build`

```
├── package.json
├── package-lock.json (or pnpm-lock.yaml, or bun.lockb)
├── build/
│   ├── client/    # Static assets
│   └── server/    # Server-side code
```

## Styling

This template does not include any styling by default, giving you full control over your application's look and feel. You can use whatever CSS framework you prefer.

---

Built with ❤️ using React Router.

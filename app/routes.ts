import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"), // ホームページ
  route("api/collect", "routes/api.collect.tsx"), // GitHub PR情報収集API
  route("api/onedrive/upload", "routes/api.onedrive.upload.tsx"), // OneDriveアップロードAPI
  route("api/onedrive/session-status", "routes/api.onedrive.session-status.tsx"), // OneDriveセッション確認API
  route("auth/onedrive/login", "routes/auth.onedrive.login.tsx"), // OneDrive OAuthログイン
  route("auth/onedrive/callback", "routes/auth.onedrive.callback.tsx"), // OneDrive OAuthコールバック
] satisfies RouteConfig;

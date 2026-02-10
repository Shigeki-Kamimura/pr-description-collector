/**
  * OneDrive OAuthサービス（サーバー側）
  * 現時点の前提:
  * - 認証フロー（OAuth/MSAL）を実装する
  * - トークンはメモリキャッシュで管理（開発用）。本番環境ではDB等に保存する想定
  * - リフレッシュトークン対応
**/

import { createCookie } from "react-router";

// Microsoft Entra ID (旧AAD) OAuth2エンドポイント
const AUTH_BASE_URL = "https://login.microsoftonline.com";
const DEFAULT_TENANT = "common";
const SCOPES = ["offline_access", "Files.ReadWrite"];

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
};

type TokenCache = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};

// メモリ上のトークンキャッシュ（開発用）
let tokenCache: TokenCache | null = null;

// OAuth状態管理用Cookie
export const onedriveOAuthStateCookie = createCookie("onedrive_oauth_state", {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  maxAge: 60 * 5,
});

// 環境変数からOAuth設定を取得する
function getTenant(): string {
  return process.env.ONEDRIVE_TENANT ?? DEFAULT_TENANT;
}

function getClientId(): string {
  return process.env.ONEDRIVE_CLIENT_ID ?? "";
}

function getClientSecret(): string {
  return process.env.ONEDRIVE_CLIENT_SECRET ?? "";
}

function getRedirectUri(): string {
  return process.env.ONEDRIVE_REDIRECT_URI ?? "";
}

// OAuth設定が完了しているか確認する
function ensureConfig() {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const redirectUri = getRedirectUri();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "OneDrive OAuth設定が未完了です。ONEDRIVE_CLIENT_ID / ONEDRIVE_CLIENT_SECRET / ONEDRIVE_REDIRECT_URI を設定してください",
    );
  }
}

// OAuthエンドポイント取得する
function getAuthorizeEndpoint(): string {
  return `${AUTH_BASE_URL}/${encodeURIComponent(getTenant())}/oauth2/v2.0/authorize`;
}

// トークンエンドポイント取得する
function getTokenEndpoint(): string {
  return `${AUTH_BASE_URL}/${encodeURIComponent(getTenant())}/oauth2/v2.0/token`;
}

// 認可URLを構築する
export function buildAuthorizeUrl(state: string): string {
  ensureConfig();
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: "code",
    redirect_uri: getRedirectUri(),
    response_mode: "query",
    scope: SCOPES.join(" "),
    state,
  });
  return `${getAuthorizeEndpoint()}?${params.toString()}`;
}

// トークンキャッシュを更新する
function setTokenCache(response: TokenResponse) {
  const expiresAt = Date.now() + Math.max(response.expires_in - 60, 30) * 1000;
  tokenCache = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? tokenCache?.refreshToken ?? null,
    expiresAt,
  };
}

// トークンをリクエストする
async function requestToken(params: URLSearchParams): Promise<TokenResponse> {
  const response = await fetch(getTokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  // エラーハンドリング
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OneDrive OAuth error (${response.status}): ${text}`);
  }

  return (await response.json()) as TokenResponse;
}

// OneDrive Graph API関連ユーティリティ
export async function exchangeCodeForToken(code: string): Promise<void> {
  ensureConfig();
  const params = new URLSearchParams({
    client_id: getClientId(),
    client_secret: getClientSecret(),
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri(),
    scope: SCOPES.join(" "),
  });
  const token = await requestToken(params);
  setTokenCache(token);
}

// リフレッシュトークンでアクセストークンを更新する
async function refreshAccessToken(refreshToken: string): Promise<void> {
  ensureConfig();
  const params = new URLSearchParams({
    client_id: getClientId(),
    client_secret: getClientSecret(),
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: SCOPES.join(" "),
  });
  const token = await requestToken(params);
  setTokenCache(token);
}

// 有効なアクセストークンを取得する
export async function getAccessToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken;
  }

  // リフレッシュトークンで更新を試みる
  if (tokenCache?.refreshToken) {
    await refreshAccessToken(tokenCache.refreshToken);
    if (tokenCache?.accessToken) return tokenCache.accessToken;
  }

  throw new Error("OneDrive OAuth token がありません。/auth/onedrive/login で認証してください。");
}

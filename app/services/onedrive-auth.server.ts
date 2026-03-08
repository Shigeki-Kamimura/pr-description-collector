/**
 * OneDrive OAuthサービス（サーバー側）
 *
 * 前提:
 * - 認証フローを実装する
 * - OAuthトークンは Redis ベースのサーバー側セッションストアで管理する
 * - リフレッシュトークン対応
 */
import { createCookie } from "react-router";
// 注意: これらの関数はサーバー側でのみ呼び出すこと。クライアント側で呼び出すとエラーになる。
import {
  clearRefreshFailure,
  getTokenForSession,
  isOAuthSessionTokenCryptoError,
  OAuthSessionStoreUnavailableError,
  releaseRefreshLock,
  storeTokenForSession,
  storeRefreshFailure,
  tryAcquireRefreshLock,
  waitForRefreshOutcome,
} from "./onedrive-oauth-session.server";
import type { TokenCache } from "./onedrive-oauth-session.server";
import { logger } from "./logger.server";
import { resolvedSessionSecret } from "./session-secret.server";

const AUTH_BASE_URL = "https://login.microsoftonline.com";
const DEFAULT_TENANT = "common";
const SCOPES = ["offline_access", "Files.ReadWrite", "User.Read"];
const DEFAULT_OAUTH_REQUEST_TIMEOUT_SECONDS = 180;
const DEFAULT_REFRESH_WAIT_TIMEOUT_SECONDS = 60;
const REFRESH_LOCK_TTL_BUFFER_MS = 5000;
const REFRESH_WAIT_GRACE_MS = 2000;

function parseTimeoutSecondsToMs(value: string | undefined, fallbackMs: number): number {
  const parsedSeconds = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0) return fallbackMs;
  return parsedSeconds * 1000;
}

const OAUTH_REQUEST_TIMEOUT_MS = parseTimeoutSecondsToMs(
  process.env.ONEDRIVE_OAUTH_REQUEST_TIMEOUT_SECONDS,
  DEFAULT_OAUTH_REQUEST_TIMEOUT_SECONDS * 1000,
);
const REFRESH_LOCK_TTL_MS = OAUTH_REQUEST_TIMEOUT_MS + REFRESH_LOCK_TTL_BUFFER_MS;
const configuredRefreshWaitMs = parseTimeoutSecondsToMs(
  process.env.ONEDRIVE_REFRESH_WAIT_TIMEOUT_SECONDS,
  DEFAULT_REFRESH_WAIT_TIMEOUT_SECONDS * 1000,
);
// lock TTL 直後の観測揺れで failure を取りこぼさないよう、follower 待機は lock TTL よりわずかに長く確保する。
const REFRESH_WAIT_MS = Math.max(configuredRefreshWaitMs, REFRESH_LOCK_TTL_MS + REFRESH_WAIT_GRACE_MS);
const REFRESH_FAILURE_TTL_SECONDS = Math.ceil(REFRESH_WAIT_MS / 1000);

// Microsoft Entra ID の token endpoint が返すレスポンスのうち、本実装で使う項目だけを表す。
type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
};

// OAuth セッションに token が存在しないことを示す専用エラー。
export class OneDriveOAuthTokenMissingError extends Error {
  constructor(message = "OneDrive OAuth token is missing.") {
    super(message);
    this.name = "OneDriveOAuthTokenMissingError";
  }
}

export function isOneDriveOAuthTokenMissingError(error: unknown): error is OneDriveOAuthTokenMissingError {
  return error instanceof OneDriveOAuthTokenMissingError;
}

function isOneDriveOAuthConfigured(): boolean {
  return Boolean(process.env.ONEDRIVE_CLIENT_ID && process.env.ONEDRIVE_CLIENT_SECRET && process.env.ONEDRIVE_REDIRECT_URI);
}

// OAuth 設定が揃っている経路では Redis も必須にし、fail-closed の前提を崩さない。
function ensureOAuthStoreConfigured() {
  if (!isOneDriveOAuthConfigured()) return;
  if (!process.env.REDIS_URL?.trim()) {
    throw new OAuthSessionStoreUnavailableError(
      "Redis session store is not configured. Set REDIS_URL before using OneDrive OAuth.",
    );
  }
}

export const onedriveOAuthStateCookie = createCookie("onedrive_oauth_state", {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  maxAge: 60 * 5,
  secure: true,
  secrets: [resolvedSessionSecret],
});

export const onedriveOAuthBindCookie = createCookie("onedrive_oauth_bind", {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  maxAge: 60 * 5,
  secure: true,
  secrets: [resolvedSessionSecret],
});

export const onedriveOAuthSessionCookie = createCookie("onedrive_oauth_session", {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  maxAge: 60 * 60 * 24 * 7,
  secure: true,
  secrets: [resolvedSessionSecret],
});

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

function ensureConfig() {
  const clientId = getClientId();
  const clientSecret = getClientSecret();
  const redirectUri = getRedirectUri();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "OneDrive OAuth設定が未完了です。ONEDRIVE_CLIENT_ID / ONEDRIVE_CLIENT_SECRET / ONEDRIVE_REDIRECT_URI を設定してください",
    );
  }
  ensureOAuthStoreConfigured();
}

function getAuthorizeEndpoint(): string {
  return `${AUTH_BASE_URL}/${encodeURIComponent(getTenant())}/oauth2/v2.0/authorize`;
}

function getTokenEndpoint(): string {
  return `${AUTH_BASE_URL}/${encodeURIComponent(getTenant())}/oauth2/v2.0/token`;
}

export function buildAuthorizeUrl(state: string): string {
  ensureConfig();
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: "code",
    redirect_uri: getRedirectUri(),
    response_mode: "query",
    scope: SCOPES.join(" "),
    state,
    prompt: "select_account",
  });
  return `${getAuthorizeEndpoint()}?${params.toString()}`;
}

// OAuth の `expires_in` をそのまま使わず、少し早めに失効扱いへ寄せて refresh の余裕を残す。
function toTokenCache(response: TokenResponse, previousRefreshToken: string | null = null): TokenCache {
  const expiresAt = Date.now() + Math.max(response.expires_in - 60, 30) * 1000;
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? previousRefreshToken,
    expiresAt,
  };
}

// Cookie 改ざんや欠落は認証切れ扱いに寄せたいため、parse 失敗時は null に丸める。
async function getSessionId(cookieHeader: string | null): Promise<string | null> {
  if (!cookieHeader) return null;
  try {
    const raw = (await onedriveOAuthSessionCookie.parse(cookieHeader)) as string | null;
    return raw ?? null;
  } catch {
    return null;
  }
}

async function requestToken(params: URLSearchParams): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(getTokenEndpoint(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: AbortSignal.timeout(OAUTH_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`OneDrive OAuth request timed out after ${OAUTH_REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OneDrive OAuth error (${response.status}): ${text}`);
  }

  return (await response.json()) as TokenResponse;
}

export async function exchangeCodeForToken(code: string): Promise<TokenCache> {
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
  return toTokenCache(token);
}

async function refreshAccessToken(refreshToken: string): Promise<TokenCache> {
  ensureConfig();
  const params = new URLSearchParams({
    client_id: getClientId(),
    client_secret: getClientSecret(),
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    scope: SCOPES.join(" "),
  });
  const token = await requestToken(params);
  return toTokenCache(token, refreshToken);
}

// Redis ストアを経由した token 永続化の入口を 1 箇所に寄せる。
export async function persistTokenForSession(sessionId: string, cache: TokenCache): Promise<void> {
  ensureOAuthStoreConfigured();
  await storeTokenForSession(sessionId, cache);
}

// 複数インスタンスでの refresh 競合を Redis ロックで直列化し、失敗時もロックを確実に解放する。
async function refreshAccessTokenForSession(sessionId: string, refreshToken: string): Promise<TokenCache> {
  const lockToken = await tryAcquireRefreshLock(sessionId, REFRESH_LOCK_TTL_MS);
  if (lockToken) {
    try {
      await clearRefreshFailure(sessionId);
      const refreshed = await refreshAccessToken(refreshToken);
      await persistTokenForSession(sessionId, refreshed);
      return refreshed;
    } catch (error) {
      if (!(error instanceof OAuthSessionStoreUnavailableError) && !isOAuthSessionTokenCryptoError(error)) {
        const message = error instanceof Error ? error.message : String(error);
        try {
          await storeRefreshFailure(sessionId, message, REFRESH_FAILURE_TTL_SECONDS);
        } catch (storeError) {
          // failure 共有の保存はベストエフォート。元の refresh 失敗理由を優先する。
          logger.warn("Failed to store OneDrive refresh failure.", {
            sessionId,
            error: storeError instanceof Error ? storeError.message : String(storeError),
          });
        }
      }
      throw error;
    } finally {
      try {
        await releaseRefreshLock(sessionId, lockToken);
      } catch (error) {
        // unlock 失敗は可用性優先でベストエフォート化し、成功済み refresh 結果は維持する。
        logger.warn("Failed to release OneDrive refresh lock.", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const outcome = await waitForRefreshOutcome(sessionId, REFRESH_WAIT_MS);
  if (outcome?.kind === "token") return outcome.token;
  if (outcome?.kind === "error") {
    throw new Error(outcome.message);
  }

  throw new OAuthSessionStoreUnavailableError(
    "Timed out while waiting for another worker to finish refreshing the OneDrive OAuth token.",
  );
}

export async function getAccessToken(request?: Request): Promise<string> {
  if (request) {
    // request 経路では、そのブラウザの sessionId に紐づく token だけを使う。
    ensureOAuthStoreConfigured();
    const sessionId = await getSessionId(request.headers.get("Cookie"));
    const sessionToken = await getTokenForSession(sessionId);

    if (sessionToken && sessionToken.expiresAt > Date.now()) {
      return sessionToken.accessToken;
    }

    if (sessionId && sessionToken?.refreshToken) {
      const refreshed = await refreshAccessTokenForSession(sessionId, sessionToken.refreshToken);
      return refreshed.accessToken;
    }

    throw new OneDriveOAuthTokenMissingError("OneDrive OAuth token is missing. Please re-authenticate.");
  }

  throw new Error(
    "request なし経路では OneDrive OAuth token を解決できません。request 付きで呼び出すか、" +
      "ONEDRIVE_ACCESS_TOKEN を設定してください。",
  );
}

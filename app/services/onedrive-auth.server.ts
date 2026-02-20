/**
  * OneDrive OAuthサービス（サーバー側）
  * 現時点の前提:
  * - 認証フロー（OAuth/MSAL）を実装する
  * - トークンはメモリキャッシュで管理（開発用）。本番環境ではDB等に保存する想定
  * - リフレッシュトークン対応
**/

// これらの関数は、OneDrive OAuthフローの実装に必要なユーティリティ関数やサービスを提供する。
// 例えば、OAuthの認可URLを生成する関数や、トークンを交換する関数などが含まれる。
// これらの関数は、認証ルートのローダーやアクションで利用される。
import { createCookie } from "react-router";

// Cookie署名用のシークレット
const sessionSecret = process.env.SESSION_SECRET ?? "";
const isProduction = process.env.NODE_ENV === "production";
const defaultDevSessionSecret =
  "dev-session-secret-pr-description-collector-please-set-session-secret-explicitly";
const usingDefaultDevSessionSecret = !sessionSecret && !isProduction;
const resolvedSessionSecret = sessionSecret || (usingDefaultDevSessionSecret ? defaultDevSessionSecret : "");

// セッションシークレットが未設定の場合はエラーを投げる。production では必須、development では警告を出す。
if (!resolvedSessionSecret) {
  throw new Error("SESSION_SECRET が未設定です。production では必須です。");
}
// 開発環境でセッションシークレットが未設定の場合は警告を出す。
// これにより、開発者がセキュリティリスクを認識できるようになる。
if (usingDefaultDevSessionSecret) {
  console.warn(
    "SESSION_SECRET が未設定のため、固定の開発用シークレットを使用しています。ローカルの安定運用のため、.env に SESSION_SECRET を明示設定してください。",
  );
}

// Microsoft Entra ID (旧AAD) OAuth2エンドポイント
const AUTH_BASE_URL = "https://login.microsoftonline.com";
// デフォルトテナント（common: 個人/組織アカウント両対応）
const DEFAULT_TENANT = "common";
// OAuthスコープ
const SCOPES = ["offline_access", "Files.ReadWrite", "User.Read"];

// OAuthトークンレスポンス
type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
};

// トークンキャッシュ構造体
type TokenCache = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};

// セッションID => トークンキャッシュ（開発用）
// Cookieにはトークン本体を入れず、セッションIDだけを保存して参照する。
// Eviction 方針:
// - Map の挿入順を利用した簡易 LRU。
// - 参照(get)・更新(store)時に delete/set で末尾へ移動し、先頭を最も古い要素として扱う。
const tokenStore = new Map<string, TokenCache>();
// 同一セッションでの同時refreshを1回に集約する。
const refreshInFlightBySession = new Map<string, Promise<TokenCache>>();
// トークンストアの最大セッション数（開発用）
const DEFAULT_TOKEN_STORE_MAX_SESSIONS = 500;
const allowInMemoryTokenStoreInProduction =
  (process.env.ONEDRIVE_ALLOW_IN_MEMORY_TOKEN_STORE_IN_PRODUCTION ?? "").toLowerCase() === "true" ||
  process.env.ONEDRIVE_ALLOW_IN_MEMORY_TOKEN_STORE_IN_PRODUCTION === "1";
let warnedInMemoryTokenStoreInProduction = false;
// OAuth設定が完了しているか確認する
function isOneDriveOAuthConfigured(): boolean {
  return Boolean(process.env.ONEDRIVE_CLIENT_ID && process.env.ONEDRIVE_CLIENT_SECRET && process.env.ONEDRIVE_REDIRECT_URI);
}
// 本番環境でメモリ内トークンストアの使用が許可されているか確認する
function ensureInMemoryTokenStoreAllowedForCurrentEnv() {
  if (!isProduction) return;
  // OneDrive OAuth を使わないデプロイでは、起動不能にしない。
  if (!isOneDriveOAuthConfigured()) return;
  if (!allowInMemoryTokenStoreInProduction) {
    throw new Error(
      "本番環境でメモリ内 tokenStore は使用できません。Redis/DB などの永続ストアを実装するか、" +
        "一時的に ONEDRIVE_ALLOW_IN_MEMORY_TOKEN_STORE_IN_PRODUCTION=true を設定してください。",
    );
  }
  if (!warnedInMemoryTokenStoreInProduction) {
    warnedInMemoryTokenStoreInProduction = true;
    console.warn(
      "本番環境でメモリ内 tokenStore を許可しています。プロセス再起動・スケールアウト時に OAuth セッションは失われます。",
    );
  }
}

// トークンストアの最大セッション数を環境変数から取得する
// 返り値: 正の整数（未設定/不正値の場合はデフォルト値を返す）
function getTokenStoreMaxSessions(): number {
  const raw = process.env.ONEDRIVE_TOKEN_STORE_MAX_SESSIONS; // 任意
  const parsed = Number.parseInt(raw ?? "", 10); // NaNの場合もある
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TOKEN_STORE_MAX_SESSIONS; // デフォルト値
  return parsed;
}

// 期限切れかつリフレッシュ不能なセッションのみ削除する
function purgeExpiredUnrefreshableTokenSessions(now = Date.now()) {
  // tokenStore を全走査して、期限切れかつリフレッシュトークンがないセッションを削除する。
  for (const [key, value] of tokenStore.entries()) {
    // 期限切れかつリフレッシュトークンがないセッションを削除
    if (value.expiresAt <= now && !value.refreshToken) {
      tokenStore.delete(key);
    }
  }
}

// トークンストアのセッション数が上限を超えていたら古いものから削除する
function enforceTokenStoreLimit() {
  // 上限セッション数を取得
  const limit = getTokenStoreMaxSessions();
  // 上限を超えていたら古いものから削除
  while (tokenStore.size > limit) {
    const oldestKey = tokenStore.keys().next().value as string | undefined;
    if (!oldestKey) break;
    tokenStore.delete(oldestKey);
  }
}
// トークンストアの管理関数
function maintainTokenStore(now = Date.now()) {
  ensureInMemoryTokenStoreAllowedForCurrentEnv();
  // 期限切れかつリフレッシュ不能なセッションを削除する。
  // これにより、無効なセッションが残らないようになる。
  purgeExpiredUnrefreshableTokenSessions(now);
  // セッション数が上限を超えていたら古いものから削除する。
  enforceTokenStoreLimit();
}

// OAuth状態管理用Cookie
export const onedriveOAuthStateCookie = createCookie("onedrive_oauth_state", {
  httpOnly: true, // cookieをJavaScriptから参照できないようにする
  path: "/",
  sameSite: "lax",
  maxAge: 60 * 5,
  secure: true, // HTTPS限定
  secrets: [resolvedSessionSecret],
});

// OAuth開始時とcallback時のブラウザ整合性を確認する短期バインドCookie
export const onedriveOAuthBindCookie = createCookie("onedrive_oauth_bind", {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  maxAge: 60 * 5,
  secure: true,
  secrets: [resolvedSessionSecret],
});

// OAuthセッションID保持用Cookie
// 値は tokenStore のキーとして利用する。
export const onedriveOAuthSessionCookie = createCookie("onedrive_oauth_session", {
  httpOnly: true, // cookieをJavaScriptから参照できないようにする
  path: "/",
  sameSite: "lax",
  maxAge: 60 * 60 * 24 * 7,
  secure: true, // HTTPS限定
  secrets: [resolvedSessionSecret],
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
    // SSOで即時リダイレクトされるケースでも、明示的に認証画面を表示する
    prompt: "select_account",
  });
  return `${getAuthorizeEndpoint()}?${params.toString()}`;
}

function toTokenCache(response: TokenResponse, previousRefreshToken: string | null = null): TokenCache {
  const expiresAt = Date.now() + Math.max(response.expires_in - 60, 30) * 1000;
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? previousRefreshToken,
    expiresAt,
  };
}
// 非同期でセッションIDをCookieから取得する
async function getSessionId(cookieHeader: string | null): Promise<string | null> {
  // Cookieヘッダーがない場合はnullを返す
  if (!cookieHeader) return null;
  try {
    // onedriveOAuthSessionCookieを使ってセッションIDを安全に取得する
    const raw = (await onedriveOAuthSessionCookie.parse(cookieHeader)) as string | null;
    return raw ?? null;
  } catch {
    // 解析に失敗した場合はnullを返す
    return null;
  }
}

export function storeTokenForSession(sessionId: string, cache: TokenCache) {
  // OAuth callback 直後に、セッションIDへ取得トークンを紐づける。
  maintainTokenStore();
  // 既存キーを再挿入してMap末尾へ移動し、LRU順序を維持する。
  tokenStore.delete(sessionId);
  // セッションIDにトークンキャッシュを保存する。
  tokenStore.set(sessionId, cache);
  // 追加後のサイズ超過を解消する。
  maintainTokenStore();
}

function getTokenForSession(sessionId: string | null): TokenCache | null {
  if (!sessionId) return null;
  // セッションIDに紐づくトークンキャッシュを取得する。
  // これにより、APIリクエストなどでセッションに対応するトークンを利用できるようになる。
  maintainTokenStore();
  const cache = tokenStore.get(sessionId);
  if (!cache) return null;
  // 参照したセッションを末尾へ移動し、最近利用順を更新する。
  tokenStore.delete(sessionId);
  tokenStore.set(sessionId, cache);
  return cache;
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

// リフレッシュトークンでアクセストークンを更新する。
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
// セッションIDとリフレッシュトークンを使ってアクセストークンを更新する。複数リクエストの同時更新を防止する。
async function refreshAccessTokenForSession(sessionId: string, refreshToken: string): Promise<TokenCache> {
  const inFlight = refreshInFlightBySession.get(sessionId);
  if (inFlight) return inFlight;

  const refreshPromise = (async () => {
    const refreshed = await refreshAccessToken(refreshToken);
    storeTokenForSession(sessionId, refreshed);
    return refreshed;
  })().finally(() => {
    refreshInFlightBySession.delete(sessionId);
  });

  refreshInFlightBySession.set(sessionId, refreshPromise);
  return refreshPromise;
}

// 有効なアクセストークンを取得する
export async function getAccessToken(request?: Request): Promise<string> {
  // API経由の取得は、必ずCookieのセッションと紐づくトークンのみを使う。
  // 別セッションのグローバルトークンを使うと401の原因になる。
  if (request) {
    const sessionId = await getSessionId(request.headers.get("Cookie"));
    const sessionToken = getTokenForSession(sessionId);

    if (sessionToken && sessionToken.expiresAt > Date.now()) {
      return sessionToken.accessToken;
    }

    if (sessionToken?.refreshToken) {
      // セッションのリフレッシュトークンで更新を試みる。成功すればセッションを継続できる。
      const refreshed = sessionId
        ? await refreshAccessTokenForSession(sessionId, sessionToken.refreshToken)
        : await refreshAccessToken(sessionToken.refreshToken);
      return refreshed.accessToken;
    }

    throw new Error("OneDrive OAuth token がありません。/auth/onedrive/login で認証してください。");
  }

  throw new Error(
    "request なし経路では OneDrive OAuth token を解決できません。request 付きで呼び出すか、" +
      "ONEDRIVE_ACCESS_TOKEN を設定してください。",
  );
}

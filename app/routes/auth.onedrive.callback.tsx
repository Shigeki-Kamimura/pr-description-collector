/** 
 * OneDrive OAuthコールバック用のルートローダー
 * 
*/

// OAuth認可コードを受け取り、アクセストークンを取得して保存する
import { redirect } from "react-router";
import { isHttpsRequest } from "../services/https-validation.server";
import { logger } from "../services/logger.server";
import {
  ensureOAuthSessionStoreAvailable,
  isOAuthSessionTokenCryptoError,
  isOAuthSessionStoreUnavailableError,
} from "../services/onedrive-oauth-session.server";
import {
  onedriveOAuthBindCookie, // OAuth開始時バインドCookie
  exchangeCodeForToken, // OneDrive OAuthトークン交換
  onedriveOAuthStateCookie, // OAuth状態管理用Cookie
  onedriveOAuthSessionCookie, // OAuthセッションID保持用Cookie
  persistTokenForSession, // セッションIDに対応するトークンを保存する
} from "../services/onedrive-auth.server";

const OAUTH_FAILED_REDIRECT_PATH = "/?onedrive=oauth_failed";
const OAUTH_INFRASTRUCTURE_ERROR_MESSAGE =
  "OneDrive 認証基盤で一時障害が発生しています。時間をおいて再試行してください。";
const OAUTH_PERSIST_FAILED_AFTER_EXCHANGE_MESSAGE =
  "OneDrive 認証情報の保存に失敗しました。Connect OneDrive から認証をやり直してください（authorization code は再利用できない可能性があります）。";

async function buildOAuthFailureRedirect() {
  const headers = new Headers();
  headers.append("Set-Cookie", await onedriveOAuthStateCookie.serialize("", { maxAge: 0 }));
  headers.append("Set-Cookie", await onedriveOAuthBindCookie.serialize("", { maxAge: 0 }));
  return redirect(OAUTH_FAILED_REDIRECT_PATH, { headers });
}

async function buildOAuthInfrastructureErrorResponse(message: string) {
  const headers = new Headers();
  headers.append("Set-Cookie", await onedriveOAuthStateCookie.serialize("", { maxAge: 0 }));
  headers.append("Set-Cookie", await onedriveOAuthBindCookie.serialize("", { maxAge: 0 }));
  return new Response(message, { status: 503, headers });
}

// コールバックURLのローダー
export async function loader({ request }: { request: Request }) {
  if (!isHttpsRequest(request)) {
    return new Response(
      "HTTPS endpoint is required for OneDrive OAuth callback. Secure Cookie is unavailable on HTTP. Access via https://localhost:5173.",
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");
  const errorCodes = url.searchParams.get("error_codes");

  if (error) {
    // 詳細はサーバーログに残し、クライアントには再試行可能な定型メッセージのみ返す。
    logger.warn("OneDrive OAuth callback returned an error.", {
      error,
      errorDescription,
      errorCodes,
    });
    return buildOAuthFailureRedirect();
  }

  // stateの検証
  const cookieHeader = request.headers.get("Cookie");
  // state と code の検証の前に、Cookieから保存していたstateを安全に取得する。
  // これにより、OAuthフローの途中でリクエストが改ざんされていないかを検証できるようになる。
  let storedState: string | null = null;
  try {
    storedState = (await onedriveOAuthStateCookie.parse(cookieHeader)) as string | null;
  } catch {
    storedState = null;
  }
  let bindIdFromCookie: string | null = null;
  try {
    bindIdFromCookie = (await onedriveOAuthBindCookie.parse(cookieHeader)) as string | null;
  } catch {
    bindIdFromCookie = null;
  }
  // stateの形式は "bindId.nonce" としているため、stateからbindIdを抽出するロジック。
  const stateSeparatorIndex = state?.indexOf(".") ?? -1;
  const hasValidStateSeparator =
    stateSeparatorIndex > 0 && stateSeparatorIndex < (state?.length ?? 0) - 1;
  const bindIdFromState = hasValidStateSeparator ? state!.slice(0, stateSeparatorIndex) : null;

  // state と code の検証（state一致 + bind cookie一致）
  if (
    !code ||
    !state ||
    !storedState ||
    state !== storedState ||
    !bindIdFromCookie ||
    !bindIdFromState ||
    bindIdFromCookie !== bindIdFromState
  ) {
    return buildOAuthFailureRedirect();
  }

  try {
    await ensureOAuthSessionStoreAvailable();
  } catch (error) {
    if (isOAuthSessionStoreUnavailableError(error)) {
      logger.error("OneDrive OAuth session store failed.", {
        message: error.message,
      });
      return new Response(OAUTH_INFRASTRUCTURE_ERROR_MESSAGE, { status: 503 });
    }
    throw error;
  }

  // コードをトークンに交換
  let tokenCache: Awaited<ReturnType<typeof exchangeCodeForToken>>;
  try {
    tokenCache = await exchangeCodeForToken(code);
  } catch (err) {
    // トークン交換失敗の原因がセッションストア障害なのかを判別し、適切なレスポンスを返す。
    if (isOAuthSessionStoreUnavailableError(err)) {
      logger.error("OneDrive OAuth session store failed.", {
        message: err.message,
      });
      return new Response(OAUTH_INFRASTRUCTURE_ERROR_MESSAGE, { status: 503 });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    // token交換失敗の詳細はサーバーログのみで扱う。
    logger.error("OneDrive OAuth token exchange failed.", { message });
    return buildOAuthFailureRedirect();
  }
  const sessionId = crypto.randomUUID();
  try {
    await persistTokenForSession(sessionId, tokenCache);
  } catch (error) {
    if (isOAuthSessionStoreUnavailableError(error) || isOAuthSessionTokenCryptoError(error)) {
      logger.error("OneDrive OAuth session store failed.", {
        message: error.message,
      });
      return buildOAuthInfrastructureErrorResponse(OAUTH_PERSIST_FAILED_AFTER_EXCHANGE_MESSAGE);
    }
    throw error;
  }

  // stateクッキーをクリアしてリダイレクト
  const headers = new Headers();
  headers.append("Set-Cookie", await onedriveOAuthStateCookie.serialize("", { maxAge: 0 }));
  headers.append("Set-Cookie", await onedriveOAuthBindCookie.serialize("", { maxAge: 0 }));
  headers.append("Set-Cookie", await onedriveOAuthSessionCookie.serialize(sessionId));
  return redirect("/?onedrive=connected", { headers });
}

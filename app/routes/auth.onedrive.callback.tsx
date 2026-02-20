/** 
 * OneDrive OAuthコールバック用のルートローダー
 * 
*/

// OAuth認可コードを受け取り、アクセストークンを取得して保存する
import { redirect } from "react-router";
import { isHttpsRequest } from "../services/https-validation.server";
import {
  onedriveOAuthBindCookie, // OAuth開始時バインドCookie
  exchangeCodeForToken, // OneDrive OAuthトークン交換
  onedriveOAuthStateCookie, // OAuth状態管理用Cookie
  onedriveOAuthSessionCookie, // OAuthセッションID保持用Cookie
  storeTokenForSession, // セッションIDに対応するトークンを保存する
} from "../services/onedrive-auth.server";

function buildOAuthRetryMessage(): string {
  return "OneDrive 認証に失敗しました。Connect OneDrive から再試行してください。";
}

// コールバックURLのローダー
export async function loader({ request }: { request: Request }) {
  if (!isHttpsRequest(request)) {
    return new Response(
      "HTTPS endpoint is required for OneDrive OAuth callback. Access via https://localhost:5173.",
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
    console.warn("OneDrive OAuth callback returned an error.", {
      error,
      errorDescription,
      errorCodes,
    });
    return new Response(
      errorCodes
        ? `${buildOAuthRetryMessage()} [codes: ${errorCodes}]`
        : buildOAuthRetryMessage(),
      { status: 400 },
    );
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

  const bindIdFromState = state?.split(".")[0] ?? null;

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
    return new Response("Invalid OAuth state or code.", { status: 400 });
  }

  // コードをトークンに交換
  let tokenCache: Awaited<ReturnType<typeof exchangeCodeForToken>>;
  try {
    tokenCache = await exchangeCodeForToken(code);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    // token交換失敗の詳細はサーバーログのみで扱う。
    console.error("OneDrive OAuth token exchange failed.", { message });
    return new Response(buildOAuthRetryMessage(), { status: 500 });
  }
  const sessionId = crypto.randomUUID();
  storeTokenForSession(sessionId, tokenCache);

  // stateクッキーをクリアしてリダイレクト
  const headers = new Headers();
  headers.append("Set-Cookie", await onedriveOAuthStateCookie.serialize("", { maxAge: 0 }));
  headers.append("Set-Cookie", await onedriveOAuthBindCookie.serialize("", { maxAge: 0 }));
  headers.append("Set-Cookie", await onedriveOAuthSessionCookie.serialize(sessionId));
  return redirect("/?onedrive=connected", { headers });
}

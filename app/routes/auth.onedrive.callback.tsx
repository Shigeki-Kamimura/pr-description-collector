/** 
 * OneDrive OAuthコールバック用のルートローダー
 * 
*/

// OAuth認可コードを受け取り、アクセストークンを取得して保存する
import { redirect } from "react-router";
import {
  exchangeCodeForToken, // OneDrive OAuthトークン交換
  onedriveOAuthStateCookie, // OAuth状態管理用Cookie
  onedriveOAuthSessionCookie, // OAuthセッションID保持用Cookie
  storeTokenForSession, // セッションIDに対応するトークンを保存する
} from "../services/onedrive-auth.server";

// コールバックURLのローダー
export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");
  const errorCodes = url.searchParams.get("error_codes");

  if (error) {
    return new Response(
      `OneDrive OAuth error: ${error}${errorDescription ? ` (${errorDescription})` : ""}${
        errorCodes ? ` [codes: ${errorCodes}]` : ""
      }`,
      { status: 400 },
    );
  }

  // stateの検証
  const cookieHeader = request.headers.get("Cookie");
  const storedState = await onedriveOAuthStateCookie.parse(cookieHeader);

  // state と code の検証
  if (!code || !state || !storedState || state !== storedState) {
    return new Response("Invalid OAuth state or code.", { status: 400 });
  }

  // コードをトークンに交換
  let tokenCache: Awaited<ReturnType<typeof exchangeCodeForToken>>;
  try {
    tokenCache = await exchangeCodeForToken(code);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(`OneDrive OAuth token error: ${message}`, { status: 500 });
  }
  const sessionId = crypto.randomUUID();
  storeTokenForSession(sessionId, tokenCache);

  // stateクッキーをクリアしてリダイレクト
  const headers = new Headers();
  headers.append("Set-Cookie", await onedriveOAuthStateCookie.serialize("", { maxAge: 0 }));
  headers.append("Set-Cookie", await onedriveOAuthSessionCookie.serialize(sessionId));
  return redirect("/?onedrive=connected", { headers });
}

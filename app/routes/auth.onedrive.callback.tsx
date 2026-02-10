/** 
 * OneDrive OAuthコールバック用のルートローダー
 * 
*/

// OAuth認可コードを受け取り、アクセストークンを取得して保存する
import { redirect } from "react-router";
import {
  exchangeCodeForToken,
  onedriveOAuthStateCookie,
} from "../services/onedrive-auth.server";

// コールバックURLのローダー
export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return new Response(
      `OneDrive OAuth error: ${error}${errorDescription ? ` (${errorDescription})` : ""}`,
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
  await exchangeCodeForToken(code);

  // stateクッキーをクリアしてリダイレクト
  const headers = new Headers();
  headers.append("Set-Cookie", await onedriveOAuthStateCookie.serialize("", { maxAge: 0 }));
  return redirect("/?onedrive=connected", { headers });
}

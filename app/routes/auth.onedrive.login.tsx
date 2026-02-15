/** 
 * OneDrive OAuthログイン用のルートローダー
*/
// ローダー関数
import { redirect } from "react-router";
// HTTPSでのアクセスを要求する。
// OneDrive OAuthはセキュアな環境でのみ動作するため、HTTPSでない場合はエラーレスポンスを返す。
import { isHttpsRequest } from "../services/https-validation.server";
import { buildAuthorizeUrl, onedriveOAuthStateCookie } from "../services/onedrive-auth.server";

// ローダー関数
export async function loader({ request }: { request: Request }) {
  // HTTPSでのアクセスを要求する。OneDrive OAuthはセキュアな環境でのみ動作するため、HTTPSでない場合はエラーレスポンスを返す。
  if (!isHttpsRequest(request)) {
    return new Response(
      "HTTPS endpoint is required for OneDrive OAuth. Access via https://localhost:5173.",
      { status: 400 },
    );
  }

  // OAuthのstateパラメータを生成してCookieに保存する。これにより、OAuthフローの途中でリクエストが改ざんされていないかを検証できるようになる。
  const state = crypto.randomUUID();
  // 認証URLを生成してリダイレクトする。ユーザーはこのURLにアクセスしてOneDriveの認証を行うことになる。
  const headers = new Headers();
  // stateをCookieに保存する。これにより、OAuthフローの途中でリクエストが改ざんされていないかを検証できるようになる。
  headers.append("Set-Cookie", await onedriveOAuthStateCookie.serialize(state));
  // 認証URLを生成してリダイレクトする。ユーザーはこのURLにアクセスしてOneDriveの認証を行うことになる。
  return redirect(buildAuthorizeUrl(state), { headers });
}

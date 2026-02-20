/** 
 * OneDrive OAuthログイン用のルートローダー
*/
// ローダー関数
import { redirect } from "react-router";
// HTTPSでのアクセスを要求する。
// OneDrive OAuthはセキュアな環境でのみ動作するため、HTTPSでない場合はエラーレスポンスを返す。
import { isHttpsRequest } from "../services/https-validation.server";
import {
  buildAuthorizeUrl,
  onedriveOAuthBindCookie,
  onedriveOAuthStateCookie,
} from "../services/onedrive-auth.server";

// ローダー関数
export async function loader({ request }: { request: Request }) {
  // HTTPSでのアクセスを要求する。OneDrive OAuthはセキュアな環境でのみ動作するため、HTTPSでない場合はエラーレスポンスを返す。
  if (!isHttpsRequest(request)) {
    return new Response(
      "HTTPS endpoint is required for OneDrive OAuth. Secure Cookie is unavailable on HTTP. Access via https://localhost:5173.",
      { status: 400 },
    );
  }

  // OAuth開始時のブラウザ文脈をcallbackで検証するため、bind IDをstateへ組み込む。
  const bindId = crypto.randomUUID();
  const nonce = crypto.randomUUID();
  const state = `${bindId}.${nonce}`;
  // 認証URLを生成してリダイレクトする。ユーザーはこのURLにアクセスしてOneDriveの認証を行うことになる。
  const headers = new Headers();
  // stateをCookieに保存する。これにより、OAuthフローの途中でリクエストが改ざんされていないかを検証できるようになる。
  headers.append("Set-Cookie", await onedriveOAuthStateCookie.serialize(state));
  headers.append("Set-Cookie", await onedriveOAuthBindCookie.serialize(bindId));
  // 認証URLを生成してリダイレクトする。ユーザーはこのURLにアクセスしてOneDriveの認証を行うことになる。
  return redirect(buildAuthorizeUrl(state), { headers });
}

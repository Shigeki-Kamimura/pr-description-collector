/** 
 * OneDrive OAuthログイン用のルートローダー
*/

import { redirect } from "react-router";
import { buildAuthorizeUrl, onedriveOAuthStateCookie } from "../services/onedrive-auth.server";

// コールバックURLのローダー
function isHttpsRequest(request: Request): boolean {
  // ローカル開発環境でプロキシ経由の場合、x-forwarded-proto ヘッダーを確認してHTTPSかどうかを判断する
  const forwardedProto = request.headers.get("x-forwarded-proto");
  // ヘッダーがない場合は、URLのプロトコルを直接確認する
  if (forwardedProto) {
    // x-forwarded-proto ヘッダーはカンマ区切りで複数のプロトコルが指定されることがあるため、最初の値を取り出して確認する
    const proto = forwardedProto.split(",")[0]?.trim();
    // HTTPSであればtrueを返す
    return proto === "https";
  }
  // ヘッダーがない場合は、URLのプロトコルを直接確認する
  return new URL(request.url).protocol === "https:";
}

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

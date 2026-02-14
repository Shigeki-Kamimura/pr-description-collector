/** 
 * OneDrive OAuthログイン用のルートローダー
*/

import { redirect } from "react-router";
import { buildAuthorizeUrl, onedriveOAuthStateCookie } from "../services/onedrive-auth.server";

// コールバックURLのローダー
function isHttpsRequest(request: Request): boolean {
  // URLのプロトコルがHTTPSであるかを確認する。OneDrive OAuthはセキュアな環境でのみ動作する
  // HTTPSでない場合はエラーレスポンスを返す。
  const url = new URL(request.url);
  if (url.protocol === "https:") return true;
  // 環境変数でX-Forwarded-Protoを信頼する設定がある場合、ヘッダーを確認してHTTPSかどうかを判断する
  const trustForwardedProto =
    (process.env.ONEDRIVE_TRUST_X_FORWARDED_PROTO ?? "").toLowerCase() === "true" ||
    process.env.ONEDRIVE_TRUST_X_FORWARDED_PROTO === "1";
    // X-Forwarded-Protoを信頼する設定がない場合は、HTTPSでないと判断する
  if (!trustForwardedProto) return false;

  // X-Forwarded-Protoヘッダーを確認してHTTPSかどうかを判断する。
  // これにより、リバースプロキシの背後で動作している場合でも正しくHTTPSを判定できるようになる。
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  // X-Forwarded-ProtoがHTTPSでない場合は、HTTPSでないと判断する
  if (forwardedProto !== "https") return false;
  // ホストが信頼できるプロキシからのものであることを確認する。
  // これにより、X-Forwarded-Protoヘッダーのなりすましを防止する。
  const host = request.headers.get("host")?.trim().toLowerCase();
  // X-Forwarded-Hostヘッダーを確認して、リクエストが信頼できるプロキシからのものであることを確認する。
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  // 信頼できるプロキシのホストを環境変数から取得する。
  // これにより、リクエストが信頼できるプロキシからのものであることを確認する。
  const trustedHosts = new Set(
    (process.env.ONEDRIVE_TRUSTED_PROXY_HOSTS ?? "localhost:5173,127.0.0.1:5173")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
  // ホストが信頼できるプロキシからのものであることを確認する。
  // これにより、X-Forwarded-Protoヘッダーのなりすましを防止する。
  return Boolean(host && forwardedHost && host === forwardedHost && trustedHosts.has(host));
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

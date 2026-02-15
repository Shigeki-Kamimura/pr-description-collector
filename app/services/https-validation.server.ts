/**
 * 
 *httpsリクエストかどうかを判定するユーティリティ関数
 *OneDrive OAuthはセキュアな環境でのみ動作するため、HTTPSでのアクセスを要求するために使用される。
 *この関数は、リクエストがHTTPSであるかどうかを判定し、必要に応じてX-Forwarded-Protoヘッダーも考慮する。
 *これにより、リバースプロキシの背後にある環境でも正しくHTTPSリクエストを判定できるようになる。

  *この関数は、OneDrive OAuthのloginとcallbackのルートローダーで使用されており、
  HTTPSでないアクセスに対して適切なエラーレスポンスを返すために利用されている。
 */

export function isHttpsRequest(request: Request): boolean {
  const url = new URL(request.url);
  if (url.protocol === "https:") return true;

  const trustForwardedProto =
    (process.env.ONEDRIVE_TRUST_X_FORWARDED_PROTO ?? "").toLowerCase() === "true" ||
    process.env.ONEDRIVE_TRUST_X_FORWARDED_PROTO === "1";
  if (!trustForwardedProto) return false;

  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (forwardedProto !== "https") return false;

  const host = request.headers.get("host")?.trim().toLowerCase();
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  const trustedHosts = new Set(
    (process.env.ONEDRIVE_TRUSTED_PROXY_HOSTS ?? "localhost:5173,127.0.0.1:5173")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean),
  );
  return Boolean(host && forwardedHost && host === forwardedHost && trustedHosts.has(host));
}

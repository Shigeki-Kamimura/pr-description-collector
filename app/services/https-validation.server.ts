/**
 * HTTPSリクエストかどうかを判定するユーティリティ。
 *
 * OneDrive OAuth はセキュアな環境でのみ動作するため、HTTPSアクセスを要求する。
 * 通常は request.url の scheme を優先し、明示的に許可された場合のみ
 * X-Forwarded-Proto / X-Forwarded-Host も考慮して判定する。
 *
 * auth.onedrive.login / auth.onedrive.callback の両ルートで共通利用する。
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

  // 任意: 共有シークレットを設定した環境では、プロキシからの正当な転送のみ許可する。
  const sharedSecret = process.env.ONEDRIVE_TRUST_PROXY_SHARED_SECRET ?? "";
  if (sharedSecret) {
    const provided = request.headers.get("x-onedrive-proxy-secret") ?? "";
    if (provided !== sharedSecret) return false;
  }

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

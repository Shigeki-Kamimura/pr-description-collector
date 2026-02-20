/**
 * CSRF対策ユーティリティ
 *
 * このファイルを作成した理由:
 * - `/api/onedrive/upload` のような状態変更POSTを、外部サイトからの不正送信（CSRF）から守るため。
 *
 * 動作概要:
 * - `ensureCsrfToken`:
 *   - リクエストCookieに `csrf_token` があればそれを再利用する。
 *   - なければ新規トークンを発行し、Set-Cookieとともに返す。
 * - `verifyCsrfToken`:
 *   - フォームの `csrfToken` と Cookie の `csrf_token` が一致するかを検証する。
 *   - 欠落または不一致の場合は `false` を返し、呼び出し側でリクエストを拒否する。
 */
import { createCookie } from "react-router";

const csrfTokenCookie = createCookie("csrf_token", {
  httpOnly: true,
  path: "/",
  sameSite: "lax",
  secure: true,
  maxAge: 60 * 60 * 8,
});

export async function ensureCsrfToken(request: Request): Promise<{ token: string; setCookie?: string }> {
  const cookieHeader = request.headers.get("Cookie");
  const existing = (await csrfTokenCookie.parse(cookieHeader)) as string | null;
  if (existing) {
    return { token: existing };
  }

  const token = crypto.randomUUID();
  const setCookie = await csrfTokenCookie.serialize(token);
  return { token, setCookie };
}

export async function verifyCsrfToken(request: Request, formData: FormData): Promise<boolean> {
  const submitted = formData.get("csrfToken");
  if (typeof submitted !== "string" || submitted.length === 0) return false;

  const cookieHeader = request.headers.get("Cookie");
  const token = (await csrfTokenCookie.parse(cookieHeader)) as string | null;
  if (!token) return false;

  return token === submitted;
}

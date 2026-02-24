/**
 * エビデンス画像取得トークンの署名ユーティリティ
 *
 * このファイルを用意した理由:
 * - `/api/onedrive/evidence-image` が `path` 改ざんで別画像へアクセスされることを防ぐため。
 *
 * このファイルが使われる場面:
 * - archive/upload で画像ごとの署名トークンを生成するとき。
 * - evidence-image API で受信トークンを検証するとき。
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { resolvedSessionSecret } from "./session-secret.server";

const TOKEN_NAMESPACE = "evidence-image-path:v1";
const TOKEN_HEX_LENGTH = 64;
const TOKEN_FORMAT_RE = /^[0-9a-f]{64}$/i;

export function signEvidenceImagePath(path: string): string {
  return createHmac("sha256", resolvedSessionSecret)
    .update(TOKEN_NAMESPACE)
    .update("\n")
    .update(path)
    .digest("hex");
}

export function isEvidenceImageTokenFormat(token: string): boolean {
  return TOKEN_FORMAT_RE.test(token);
}

export function verifyEvidenceImagePathToken(path: string, token: string): boolean {
  if (!path || !isEvidenceImageTokenFormat(token)) return false;
  const expectedHex = signEvidenceImagePath(path);
  if (expectedHex.length !== TOKEN_HEX_LENGTH) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(token.toLowerCase(), "hex");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

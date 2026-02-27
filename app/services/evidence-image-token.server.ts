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
const TOKEN_TTL_MS = 10 * 60 * 1000;
const TOKEN_FORMAT_RE = /^([0-9a-f]{64}):([0-9]{10,16})$/i;

function signEvidenceImagePathWithExpiry(path: string, expiresAtUnixMs: string): string {
  return createHmac("sha256", resolvedSessionSecret)
    .update(TOKEN_NAMESPACE)
    .update("\n")
    .update(path)
    .update("\n")
    .update(expiresAtUnixMs)
    .digest("hex");
}

// 設計メモ: トークンは、`{hex}:{expiresAtUnixMs}` 形式の文字列で、`hex` は `path` と `expiresAtUnixMs` を HMAC-SHA256 署名したもの。
function parseTokenParts(token: string): { macHex: string; expiresAtUnixMs: string } | null {
  const matched = token.match(TOKEN_FORMAT_RE);
  if (!matched) return null;
  return {
    macHex: matched[1]?.toLowerCase() ?? "",
    expiresAtUnixMs: matched[2] ?? "",
  };
}
export function signEvidenceImagePath(path: string): string {
  const expiresAtUnixMs = String(Date.now() + TOKEN_TTL_MS);
  const macHex = signEvidenceImagePathWithExpiry(path, expiresAtUnixMs);
  return `${macHex}:${expiresAtUnixMs}`;
}
export function isEvidenceImageTokenFormat(token: string): boolean {
  return parseTokenParts(token) !== null;
}
// 設計メモ: トークン検証は、トークン形式の確認、有効期限の確認、そして提供されたトークンと期待されるトークンを timingSafeEqual で比較することで行う。
export function verifyEvidenceImagePathToken(path: string, token: string): boolean {
  if (!path) return false;
  const tokenParts = parseTokenParts(token);
  if (!tokenParts) return false;
  const expiresAtUnixMs = Number.parseInt(tokenParts.expiresAtUnixMs, 10);
  if (!Number.isFinite(expiresAtUnixMs)) return false;
  if (Date.now() > expiresAtUnixMs) return false;
// トークンの再生成と timingSafeEqual による比較
  const expectedHex = signEvidenceImagePathWithExpiry(path, tokenParts.expiresAtUnixMs);
  if (expectedHex.length !== TOKEN_HEX_LENGTH) return false;
  const expected = Buffer.from(expectedHex, "hex");
  const provided = Buffer.from(tokenParts.macHex, "hex");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

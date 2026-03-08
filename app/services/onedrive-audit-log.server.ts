/**
 * このファイルを用意した理由:
 * - OneDrive OAuth/保存系の障害ログを構造化し、機微情報を一貫してマスキングするため。
 *
 * このファイルが使われる場面:
 * - `api.onedrive.upload` / `api.onedrive.archive` / `api.onedrive.evidence-image` /
 *   `api.onedrive.session-status` / `onedrive-oauth-session` の失敗ログを出力するとき。
 */
import { extractOneDriveError } from "./onedrive-errors.server";

const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|cookie)/i;
const REDACTED = "[REDACTED]";

const SENSITIVE_TEXT_PATTERNS = [
  /([?&](?:access_token|refresh_token|token|client_secret|code)=)[^&\s]+/gi,
  /\bBearer\s+[A-Za-z0-9._~+\-/]+=*\b/gi,
  /((?:access[_-]?token|refresh[_-]?token|token|secret|password|authorization|cookie)\s*[:=]\s*)([^\s,;]+)/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+\b/g,
];

function maskSensitiveText(value: string): string {
  // URLクエリ/ヘッダー形式/トークン文字列の揺れをまとめてマスクする。
  let sanitized = value;
  for (const pattern of SENSITIVE_TEXT_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match, keyPrefix) => {
      if (typeof keyPrefix === "string") {
        return `${keyPrefix}${REDACTED}`;
      }
      return REDACTED;
    });
  }
  return sanitized;
}

function sanitizeAuditValue(value: unknown, depth = 0): unknown {
  // 深すぎるネストは切り詰めて、循環や巨大payloadでログが肥大化するのを防ぐ。
  if (depth > 4) return "[TRUNCATED]";
  if (typeof value === "string") return maskSensitiveText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeAuditValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = REDACTED;
        continue;
      }
      sanitized[key] = sanitizeAuditValue(entry, depth + 1);
    }
    return sanitized;
  }
  return String(value);
}

export function sanitizeAuditPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return sanitizeAuditValue(payload) as Record<string, unknown>;
}

export function buildOneDriveAuditErrorPayload({
  event,
  route,
  error,
  status,
  failureType,
  extra,
}: {
  event: string;
  route: string;
  error: unknown;
  status?: number;
  failureType: string;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  // ルート層で使う監査ログの共通フォーマットをここで固定する。
  const rawMessage = error instanceof Error ? error.message : String(error);
  const parsed = extractOneDriveError(rawMessage);
  return sanitizeAuditPayload({
    event,
    route,
    failureType,
    status: status ?? null,
    errorName: error instanceof Error ? error.name : typeof error,
    message: rawMessage,
    code: parsed.code ?? null,
    detail: parsed.message ?? null,
    ...(extra ?? {}),
  });
}

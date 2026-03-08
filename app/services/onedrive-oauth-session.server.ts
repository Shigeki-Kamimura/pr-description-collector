/**
 * OneDrive OAuth セッションストア
 *
 * このファイルを用意した理由:
 * - OneDrive OAuth の token cache と refresh ロックを Redis ベースで一元管理するため。
 * - Redis 障害を OAuth 認証エラーと分離し、専用エラーへ正規化するため。
 *
 * このファイルが使われる場面:
 * - callback 後に access token / refresh token を保存するとき。
 * - API 実行時に sessionId から token cache を参照するとき。
 * - 複数インスタンスで token refresh の多重実行を抑止するとき。
 */
import { redisCompareAndDelete, redisDel, redisGet, redisSetEx, redisSetNxPx } from "./redis.server";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { resolvedSessionSecret } from "./session-secret.server";
import { logger } from "./logger.server";

// 定数定義。呼び出し側はこれらの値を知らなくていいように、必要なロジックはこのファイル内に閉じ込める。
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const REFRESH_LOCK_POLL_INITIAL_MS = 100;
const REFRESH_LOCK_POLL_MAX_MS = 1000;
const STORE_PROBE_TTL_SECONDS = 5;
const SESSION_KEY_PREFIX = "onedrive:session:";
const STORE_PROBE_KEY_PREFIX = "onedrive:probe:";
const REFRESH_LOCK_KEY_PREFIX = "onedrive:refresh-lock:";
const REFRESH_FAILURE_KEY_PREFIX = "onedrive:refresh-failure:";
const TOKEN_ENCRYPTION_ALGORITHM = "aes-256-gcm";
const TOKEN_ENCRYPTION_VERSION_PREFIX = "v1";
const TOKEN_ENCRYPTION_IV_BYTES = 12;
const TOKEN_ENCRYPTION_AUTH_TAG_BYTES = 16;

// OneDrive OAuth の server-side session に保存する最小契約。
export type TokenCache = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};
// セッション秘密鍵から32byte鍵を導出し、token暗号化/復号で共通利用する。
const tokenEncryptionKey = createHash("sha256").update(resolvedSessionSecret, "utf8").digest();

// Redis 障害を認証切れと区別するための専用エラー。
export class OAuthSessionStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OAuthSessionStoreUnavailableError";
  }
}

// token 暗号化の失敗を Redis 障害と区別して扱う専用エラー。
export class OAuthSessionTokenCryptoError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OAuthSessionTokenCryptoError";
  }
}
// OAuthSessionStoreUnavailableError 型ガード。これを使うことで、呼び出し側は Redis 障害と認証エラーを明確に分けて扱えるようになる。
export function isOAuthSessionStoreUnavailableError(error: unknown): error is OAuthSessionStoreUnavailableError {
  return error instanceof OAuthSessionStoreUnavailableError;
}

export function isOAuthSessionTokenCryptoError(error: unknown): error is OAuthSessionTokenCryptoError {
  return error instanceof OAuthSessionTokenCryptoError;
}

// Redis 上の key 命名規則を閉じ込め、呼び出し側に prefix 知識を漏らさない。
function toSessionKey(sessionId: string): string {
  return `${SESSION_KEY_PREFIX}${sessionId}`;
}

function toStoreProbeKey(probeId: string): string {
  return `${STORE_PROBE_KEY_PREFIX}${probeId}`;
}

function toRefreshLockKey(sessionId: string): string {
  return `${REFRESH_LOCK_KEY_PREFIX}${sessionId}`;
}

function toRefreshFailureKey(sessionId: string): string {
  return `${REFRESH_FAILURE_KEY_PREFIX}${sessionId}`;
}

// Redis 例外を OAuth 専用のインフラ障害へ変換し、UI 側の扱いを一貫させる。
function toStoreUnavailableError(action: string, error: unknown): OAuthSessionStoreUnavailableError {
  const message = error instanceof Error ? error.message : String(error);
  return new OAuthSessionStoreUnavailableError(`Redis session store ${action} failed: ${message}`, {
    cause: error,
  });
}

function toTokenCryptoError(action: "encrypt" | "decrypt", error: unknown): OAuthSessionTokenCryptoError {
  const message = error instanceof Error ? error.message : String(error);
  return new OAuthSessionTokenCryptoError(`OneDrive token crypto ${action} failed: ${message}`, {
    cause: error,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

type ParseTokenCacheResult =
  | { cache: TokenCache; reason: null }
  | { cache: null; reason: string };

function encryptTokenCache(cache: TokenCache): string {
  const iv = randomBytes(TOKEN_ENCRYPTION_IV_BYTES);
  const cipher = createCipheriv(TOKEN_ENCRYPTION_ALGORITHM, tokenEncryptionKey, iv);
  const plaintext = JSON.stringify(cache);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // バージョン.iv.authTag.ciphertext の順で保存し、将来の形式変更に備える。
  return [
    TOKEN_ENCRYPTION_VERSION_PREFIX,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

// 復号後の値が正しい token cache 形式か最低限検証し、壊れた値を業務ロジックへ渡さない。
function parseTokenCache(value: string): ParseTokenCacheResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { cache: null, reason: "invalid-json" };
  }

  if (!parsed || typeof parsed !== "object") {
    return { cache: null, reason: "invalid-json-shape" };
  }

  const candidate = parsed as Partial<TokenCache>;
  if (typeof candidate.accessToken !== "string") {
    return { cache: null, reason: "invalid-access-token-type" };
  }
  if (candidate.refreshToken !== null && typeof candidate.refreshToken !== "string") {
    return { cache: null, reason: "invalid-refresh-token-type" };
  }
  if (typeof candidate.expiresAt !== "number" || !Number.isFinite(candidate.expiresAt)) {
    return { cache: null, reason: "invalid-expires-at" };
  }

  return {
    cache: {
      accessToken: candidate.accessToken,
      refreshToken: candidate.refreshToken,
      expiresAt: candidate.expiresAt,
    },
    reason: null,
  };
}
// decryptTokenCache と parseTokenCache を分けることで、暗号化の失敗と形式の不正を区別してログに出せるようにする。
type DecryptTokenCacheResult =
  | { cache: TokenCache; reason: null }
  | { cache: null; reason: string };

// 暗号化形式以外は旧形式として即無効化する（fail-closed）。
function decryptTokenCache(value: string): DecryptTokenCacheResult {
  const segments = value.split(".");
  if (segments.length !== 4) return { cache: null, reason: "invalid-segment-count" };
  if (segments[0] !== TOKEN_ENCRYPTION_VERSION_PREFIX) return { cache: null, reason: "unknown-version" };

  // 復号前に IV と authTag の長さを検査し、壊れた値を業務ロジックへ渡さない。
  try {
    const iv = Buffer.from(segments[1] ?? "", "base64url");
    const authTag = Buffer.from(segments[2] ?? "", "base64url");
    const encrypted = Buffer.from(segments[3] ?? "", "base64url");
    if (iv.length !== TOKEN_ENCRYPTION_IV_BYTES) return { cache: null, reason: "invalid-iv-length" };
    if (authTag.length !== TOKEN_ENCRYPTION_AUTH_TAG_BYTES) return { cache: null, reason: "invalid-auth-tag-length" };

    const decipher = createDecipheriv(TOKEN_ENCRYPTION_ALGORITHM, tokenEncryptionKey, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    return parseTokenCache(decrypted);
  } catch {
    return { cache: null, reason: "decrypt-failed" };
  }
}
// 以下、Redis ストアを経由した OneDrive OAuth token 永続化の実装。呼び出し側はこれらの関数を通じて sessionId と token cache をやりとりする。
export async function ensureOAuthSessionStoreAvailable(): Promise<void> {
  const probeId = crypto.randomUUID();
  const probeKey = toStoreProbeKey(probeId);
  try {
    await redisSetEx(probeKey, probeId, STORE_PROBE_TTL_SECONDS);
    const storedValue = await redisGet(probeKey);
    if (storedValue !== probeId) {
      throw new Error("Redis session store probe returned an unexpected value");
    }
    await redisDel(probeKey);
  } catch (error) {
    throw toStoreUnavailableError("probe", error);
  }
}

// token cache を暗号化して Redis に保存する。暗号化失敗と Redis 障害を区別して専用エラーを投げる。
export async function storeTokenForSession(sessionId: string, cache: TokenCache): Promise<void> {
  let encryptedCache: string;
  try {
    encryptedCache = encryptTokenCache(cache);
  } catch (error) {
    throw toTokenCryptoError("encrypt", error);
  }

  try {
    await redisSetEx(toSessionKey(sessionId), encryptedCache, SESSION_TTL_SECONDS);
  } catch (error) {
    throw toStoreUnavailableError("write", error);
  }
}

// 破損セッションの cleanup はベストエフォートで行い、認証切れ扱いを優先する。
async function deleteCorruptedSessionKey(sessionId: string): Promise<void> {
  try {
    await redisDel(toSessionKey(sessionId));
  } catch {
    // cleanup 失敗は握りつぶし、元の処理結果を優先する。
  }
}

// Redis から読んだ暗号化 payload を最低限検証し、壊れた値をそのまま業務ロジックへ渡さない。
export async function getTokenForSession(sessionId: string | null): Promise<TokenCache | null> {
  if (!sessionId) return null;

  let raw: string | null;
  try {
    raw = await redisGet(toSessionKey(sessionId));
  } catch (error) {
    throw toStoreUnavailableError("read", error);
  }

  if (!raw) return null;

  const decrypted = decryptTokenCache(raw);
  if (!decrypted.cache) {
    logger.warn("Discarding invalid OneDrive OAuth session token.", {
      sessionId,
      reason: decrypted.reason,
    });
    await deleteCorruptedSessionKey(sessionId);
    return null;
  }
  return decrypted.cache;
}
// セッション削除は認証切れと同等の扱いで、呼び出し側で必要に応じて再認証フローへ誘導する。
export async function deleteTokenForSession(sessionId: string): Promise<void> {
  try {
    await redisDel(toSessionKey(sessionId));
  } catch (error) {
    throw toStoreUnavailableError("delete", error);
  }
}

// refresh を実行する worker だけが続行できるよう、トークン付きロックを返す。
// TTL は呼び出し元が refresh の最長実行時間に合わせて渡す。
export async function tryAcquireRefreshLock(sessionId: string, ttlMs: number): Promise<string | null> {
  const token = crypto.randomUUID();
  try {
    const acquired = await redisSetNxPx(toRefreshLockKey(sessionId), token, ttlMs);
    return acquired ? token : null;
  } catch (error) {
    throw toStoreUnavailableError("lock", error);
  }
}

// compare-and-delete で、自分が取ったロックだけを安全に解放する。
export async function releaseRefreshLock(sessionId: string, lockToken: string): Promise<void> {
  try {
    await redisCompareAndDelete(toRefreshLockKey(sessionId), lockToken);
  } catch (error) {
    throw toStoreUnavailableError("unlock", error);
  }
}

// 新しい refresh の開始前に前回失敗結果を消し、古い失敗情報を後続へ誤配信しない。
export async function clearRefreshFailure(sessionId: string): Promise<void> {
  try {
    await redisDel(toRefreshFailureKey(sessionId));
  } catch (error) {
    throw toStoreUnavailableError("clear-refresh-failure", error);
  }
}

// 先行 worker の refresh 失敗を短期保存し、後続 worker に同じ失敗理由を返せるようにする。
export async function storeRefreshFailure(sessionId: string, message: string, ttlSeconds: number): Promise<void> {
  try {
    await redisSetEx(toRefreshFailureKey(sessionId), message, ttlSeconds);
  } catch (error) {
    throw toStoreUnavailableError("write-refresh-failure", error);
  }
}

// refresh failure 読み取りも専用エラーへ正規化し、follower 側で Redis 障害を取りこぼさない。
async function getRefreshFailure(sessionId: string): Promise<string | null> {
  try {
    return await redisGet(toRefreshFailureKey(sessionId));
  } catch (error) {
    throw toStoreUnavailableError("read-refresh-failure", error);
  }
}

// stale refresh failure 誤検知を避けるため、follower は lock の有無も参照して確定失敗か判定する。
async function hasActiveRefreshLock(sessionId: string): Promise<boolean> {
  try {
    const lockToken = await redisGet(toRefreshLockKey(sessionId));
    return Boolean(lockToken);
  } catch (error) {
    throw toStoreUnavailableError("read-refresh-lock", error);
  }
}

export type RefreshOutcome =
  | { kind: "token"; token: TokenCache }
  | { kind: "error"; message: string };

// 他 worker の refresh 完了または失敗を待ち、結果が出たら同じ outcome を返す。
export async function waitForRefreshOutcome(sessionId: string, waitMs: number): Promise<RefreshOutcome | null> {
  const deadline = Date.now() + waitMs;
  let pollMs = REFRESH_LOCK_POLL_INITIAL_MS;
  while (Date.now() < deadline) {
    const token = await getTokenForSession(sessionId);
    if (token && token.expiresAt > Date.now()) {
      return { kind: "token", token };
    }

    const refreshFailure = await getRefreshFailure(sessionId);
    if (refreshFailure) {
      if (!(await hasActiveRefreshLock(sessionId))) {
        return { kind: "error", message: refreshFailure };
      }
    }

    await sleep(pollMs);
    pollMs = Math.min(REFRESH_LOCK_POLL_MAX_MS, pollMs * 2);
  }
  return null;
}

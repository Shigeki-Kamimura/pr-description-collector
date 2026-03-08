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
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { resolvedSessionSecret } from "./session-secret.server";
import { logger } from "./logger.server";
import { sanitizeAuditPayload } from "./onedrive-audit-log.server";

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
const TOKEN_ENCRYPTION_KDF_CONTEXT = "onedrive-oauth-token-encryption";
const TOKEN_ENCRYPTION_KEY_VERSION_PATTERN = /^[A-Za-z0-9_-]+$/;
function readOptionalNonEmptyEnv(envName: string): string | undefined {
  const raw = process.env[envName];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length > 0) return trimmed;
  throw new Error(`${envName} は空文字を許可しません。未設定にするか、有効な値を設定してください。`);
}

const TOKEN_ENCRYPTION_CURRENT_KEY_VERSION = readOptionalNonEmptyEnv("ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_VERSION") ?? "k1";
const TOKEN_ENCRYPTION_CURRENT_KEY_MATERIAL =
  readOptionalNonEmptyEnv("ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_MATERIAL") ?? resolvedSessionSecret;
const TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION = readOptionalNonEmptyEnv("ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION") ?? "";
const TOKEN_ENCRYPTION_PREVIOUS_KEY_MATERIAL = readOptionalNonEmptyEnv("ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_MATERIAL") ?? "";
const TOKEN_ENCRYPTION_ALLOW_SESSION_INVALIDATION =
  process.env.ONEDRIVE_TOKEN_ENCRYPTION_ALLOW_SESSION_INVALIDATION?.trim().toLowerCase() === "true";

// OneDrive OAuth の server-side session に保存する最小契約。
export type TokenCache = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};
// これらの関数は、OneDrive OAuth フローの中で、sessionId と token cache をやりとりするために呼び出される。
// 呼び出し側は sessionId を直接 Redis に触らず、これらの関数を通じて token cache を保存・取得する。
// これにより、暗号化や Redis 障害の扱いをこのファイル内に閉じ込め、呼び出し側はシンプルな API を使うだけでよくなる。
type TokenEncryptionKey = {
  version: string;
  key: Buffer;
};

// 旧実装（v1.iv.authTag.ciphertext）互換: sha256(SESSION_SECRET) 導出鍵
const legacyTokenEncryptionKey = createHash("sha256").update(resolvedSessionSecret, "utf8").digest();

function deriveTokenEncryptionKey(material: string, version: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(material, "utf8"), Buffer.from(version, "utf8"), TOKEN_ENCRYPTION_KDF_CONTEXT, 32));
}

// 鍵バージョンは英数字・ハイフン・アンダースコアのみ許可し、ログに出す際の安全性を確保する。
function validateTokenEncryptionKeyVersion(envName: string, value: string): void {
  if (TOKEN_ENCRYPTION_KEY_VERSION_PATTERN.test(value)) return;
  throw new Error(
    `${envName} の値 "${value}" は無効です。英数字・ハイフン(-)・アンダースコア(_)のみ使用できます。`,
  );
}

function resolveTokenEncryptionKeys(): { current: TokenEncryptionKey; previous: TokenEncryptionKey | null } {
  // 現行キーは必須、前回キーは任意。前回キーが不完全な場合はエラーにする。
  validateTokenEncryptionKeyVersion("ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_VERSION", TOKEN_ENCRYPTION_CURRENT_KEY_VERSION);
  const current: TokenEncryptionKey = {
    version: TOKEN_ENCRYPTION_CURRENT_KEY_VERSION,
    key: deriveTokenEncryptionKey(TOKEN_ENCRYPTION_CURRENT_KEY_MATERIAL, TOKEN_ENCRYPTION_CURRENT_KEY_VERSION),
  };

  if (!TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION && !TOKEN_ENCRYPTION_PREVIOUS_KEY_MATERIAL) {
    if (TOKEN_ENCRYPTION_CURRENT_KEY_VERSION !== "k1") {
      if (!TOKEN_ENCRYPTION_ALLOW_SESSION_INVALIDATION) {
        throw new Error(
          "ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION / ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_MATERIAL が未設定です。" +
            "ローテーション時は previous 鍵を設定するか、意図的に全セッションを失効させる場合のみ " +
            "ONEDRIVE_TOKEN_ENCRYPTION_ALLOW_SESSION_INVALIDATION=true を指定してください。",
        );
      }
      logger.warn("OneDrive token encryption rotation proceeds without previous key; existing sessions may be invalidated.", {
        ...sanitizeAuditPayload({
          event: "onedrive.rotation-without-previous-key",
          route: "onedrive-oauth-session",
          currentKeyVersion: TOKEN_ENCRYPTION_CURRENT_KEY_VERSION,
        }),
      });
    }
    return { current, previous: null };
  }
  if (!TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION || !TOKEN_ENCRYPTION_PREVIOUS_KEY_MATERIAL) {
    throw new Error(
      "ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION と ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_MATERIAL はセットで指定してください。",
    );
  }
  validateTokenEncryptionKeyVersion("ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION", TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION);
  if (TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION === TOKEN_ENCRYPTION_CURRENT_KEY_VERSION) {
    throw new Error(
      "ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION は current と異なる値を指定してください。同一値はローテーション設定ミスです。",
    );
  }
  const previous: TokenEncryptionKey = {
    version: TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION,
    key: deriveTokenEncryptionKey(TOKEN_ENCRYPTION_PREVIOUS_KEY_MATERIAL, TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION),
  };
  return { current, previous };
}

const tokenEncryptionKeys = resolveTokenEncryptionKeys();
const SESSION_ID_LOG_HASH_PREFIX_LENGTH = 12;

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
// sessionId を直接ログに出すのは避け、ハッシュ化して一部だけ出すことで、障害調査に必要な識別性を保ちつつ、セキュリティリスクを減らす。
function toSessionIdLogHash(sessionId: string): string {
  return createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, SESSION_ID_LOG_HASH_PREFIX_LENGTH);
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
  const cipher = createCipheriv(TOKEN_ENCRYPTION_ALGORITHM, tokenEncryptionKeys.current.key, iv);
  const plaintext = JSON.stringify(cache);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // バージョン.keyVersion.iv.authTag.ciphertext の順で保存し、鍵ローテーションに備える。
  return [
    TOKEN_ENCRYPTION_VERSION_PREFIX,
    tokenEncryptionKeys.current.version,
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
  | { cache: null; reason: string; cause?: string };

function classifyDecryptFailureCause(error: unknown): string {
  // OpenSSL 由来の例外文言ゆれを、運用で集計しやすい固定コードへ寄せる。
  if (!(error instanceof Error)) return "unexpected-error";
  const message = error.message.toLowerCase();
  if (message.includes("authenticate") || message.includes("auth tag")) {
    return "auth-failed";
  }
  if (message.includes("invalid") || message.includes("length") || message.includes("format")) {
    return "invalid-ciphertext";
  }
  return "unexpected-error";
}

function decryptTokenCacheWithKey(
  ivSegment: string,
  authTagSegment: string,
  ciphertextSegment: string,
  key: Buffer,
): ParseTokenCacheResult {
  // セグメント境界チェックを先に行い、復号処理へ不正データを渡さない。
  const iv = Buffer.from(ivSegment, "base64url");
  const authTag = Buffer.from(authTagSegment, "base64url");
  const encrypted = Buffer.from(ciphertextSegment, "base64url");
  if (iv.length !== TOKEN_ENCRYPTION_IV_BYTES) return { cache: null, reason: "invalid-iv-length" };
  if (authTag.length !== TOKEN_ENCRYPTION_AUTH_TAG_BYTES) return { cache: null, reason: "invalid-auth-tag-length" };

  const decipher = createDecipheriv(TOKEN_ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
  return parseTokenCache(decrypted);
}

function resolveKeyByVersion(version: string): TokenEncryptionKey | null {
  // 5-segment 形式は keyVersion 指定の鍵だけを使い、総当たり復号はしない。
  if (version === tokenEncryptionKeys.current.version) return tokenEncryptionKeys.current;
  if (tokenEncryptionKeys.previous && version === tokenEncryptionKeys.previous.version) return tokenEncryptionKeys.previous;
  return null;
}

// 暗号化形式以外は旧形式として即無効化する（fail-closed）。
function decryptTokenCache(value: string): DecryptTokenCacheResult {
  const segments = value.split(".");
  if (segments.length === 5) {
    // 新形式は keyVersion 固定で1鍵のみ試行し、復号不能は fail-closed。
    if (segments[0] !== TOKEN_ENCRYPTION_VERSION_PREFIX) return { cache: null, reason: "unknown-version" };
    const keyVersion = segments[1] ?? "";
    const keyEntry = resolveKeyByVersion(keyVersion);
    if (!keyEntry) return { cache: null, reason: "unknown-key-version" };

    try {
      return decryptTokenCacheWithKey(segments[2] ?? "", segments[3] ?? "", segments[4] ?? "", keyEntry.key);
    } catch (error) {
      return { cache: null, reason: "decrypt-failed", cause: classifyDecryptFailureCause(error) };
    }
  }

  if (segments.length === 4) {
    // 旧形式のみ後方互換のために順序付きフォールバックを許可する。
    if (segments[0] !== TOKEN_ENCRYPTION_VERSION_PREFIX) return { cache: null, reason: "unknown-version" };
    const keysToTry = [
      tokenEncryptionKeys.current.key,
      tokenEncryptionKeys.previous?.key ?? null,
      legacyTokenEncryptionKey,
    ].filter((entry): entry is Buffer => Boolean(entry));
    let lastError: unknown = null;
    for (const key of keysToTry) {
      try {
        return decryptTokenCacheWithKey(segments[1] ?? "", segments[2] ?? "", segments[3] ?? "", key);
      } catch (error) {
        lastError = error;
      }
    }
    return { cache: null, reason: "decrypt-failed", cause: classifyDecryptFailureCause(lastError) };
  }

  return { cache: null, reason: "invalid-segment-count" };
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
      ...sanitizeAuditPayload({
        event: "onedrive.invalid-session-token-discarded",
        route: "onedrive-oauth-session",
        sessionIdHash: toSessionIdLogHash(sessionId),
        reason: decrypted.reason,
        ...(decrypted.cause ? { cause: decrypted.cause } : {}),
      }),
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

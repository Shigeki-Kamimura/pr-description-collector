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

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const REFRESH_LOCK_POLL_MS = 100;
const STORE_PROBE_TTL_SECONDS = 5;
const SESSION_KEY_PREFIX = "onedrive:session:";
const STORE_PROBE_KEY_PREFIX = "onedrive:probe:";
const REFRESH_LOCK_KEY_PREFIX = "onedrive:refresh-lock:";
const REFRESH_FAILURE_KEY_PREFIX = "onedrive:refresh-failure:";

// OneDrive OAuth の server-side session に保存する最小契約。
export type TokenCache = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};

// Redis 障害を認証切れと区別するための専用エラー。
export class OAuthSessionStoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OAuthSessionStoreUnavailableError";
  }
}
// OAuthSessionStoreUnavailableError 型ガード。これを使うことで、呼び出し側は Redis 障害と認証エラーを明確に分けて扱えるようになる。
export function isOAuthSessionStoreUnavailableError(error: unknown): error is OAuthSessionStoreUnavailableError {
  return error instanceof OAuthSessionStoreUnavailableError;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

export async function storeTokenForSession(sessionId: string, cache: TokenCache): Promise<void> {
  try {
    await redisSetEx(toSessionKey(sessionId), JSON.stringify(cache), SESSION_TTL_SECONDS);
  } catch (error) {
    throw toStoreUnavailableError("write", error);
  }
}

// Redis から読んだ JSON を最低限検証し、壊れた値をそのまま業務ロジックへ渡さない。
export async function getTokenForSession(sessionId: string | null): Promise<TokenCache | null> {
  if (!sessionId) return null;
  try {
    const raw = await redisGet(toSessionKey(sessionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TokenCache;
    if (typeof parsed.accessToken !== "string") return null;
    if (parsed.refreshToken !== null && typeof parsed.refreshToken !== "string") return null;
    if (typeof parsed.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt)) return null;
    return parsed;
  } catch (error) {
    throw toStoreUnavailableError("read", error);
  }
}

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

export type RefreshOutcome =
  | { kind: "token"; token: TokenCache }
  | { kind: "error"; message: string };

// 他 worker の refresh 完了または失敗を待ち、結果が出たら同じ outcome を返す。
export async function waitForRefreshOutcome(sessionId: string, waitMs: number): Promise<RefreshOutcome | null> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const token = await getTokenForSession(sessionId);
    if (token && token.expiresAt > Date.now()) {
      return { kind: "token", token };
    }

    const refreshFailure = await getRefreshFailure(sessionId);
    if (refreshFailure) {
      return { kind: "error", message: refreshFailure };
    }

    await sleep(REFRESH_LOCK_POLL_MS);
  }
  return null;
}

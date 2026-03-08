/**
 * OneDrive OAuth セッションストアのテスト
 *
 * このファイルを用意した理由:
 * - session store preflight と refresh follower 経路での Redis 障害正規化契約を固定するため。
 *
 * このファイルが使われる場面:
 * - `ensureOAuthSessionStoreAvailable` が write/read/delete probe を行うか確認するとき。
 * - `waitForRefreshOutcome` が Redis read 障害を `OAuthSessionStoreUnavailableError` として返すか確認するとき。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { redisMockState } = vi.hoisted(() => ({
  redisMockState: {
    deletedProbeKeys: [] as string[],
    probeReadValueOverride: null as string | null,
    probeStoredValue: null as string | null,
    probeWriteError: null as Error | null,
    sessionRawValue: null as string | null,
    refreshFailureValue: null as string | null,
    refreshLockValue: null as string | null,
    refreshFailureReadError: null as Error | null,
    refreshLockReadError: null as Error | null,
    sessionReadError: null as Error | null,
    sessionDeleteError: null as Error | null,
    deletedSessionKeys: [] as string[],
    redisGetCallCount: 0,
  },
}));

vi.mock("./redis.server", () => ({
  redisCompareAndDelete: vi.fn(),
  redisDel: vi.fn(async (key: string) => {
    if (key.startsWith("onedrive:probe:")) {
      redisMockState.deletedProbeKeys.push(key);
      redisMockState.probeStoredValue = null;
    }
    if (key.startsWith("onedrive:session:")) {
      if (redisMockState.sessionDeleteError) {
        throw redisMockState.sessionDeleteError;
      }
      redisMockState.deletedSessionKeys.push(key);
      redisMockState.sessionRawValue = null;
    }
  }),
  redisSetEx: vi.fn(async (key: string, value: string) => {
    if (key.startsWith("onedrive:probe:")) {
      if (redisMockState.probeWriteError) {
        throw redisMockState.probeWriteError;
      }
      redisMockState.probeStoredValue = value;
    }
    if (key.startsWith("onedrive:session:")) {
      redisMockState.sessionRawValue = value;
    }
  }),
  redisSetNxPx: vi.fn(),
  redisGet: vi.fn(async (key: string) => {
    redisMockState.redisGetCallCount += 1;
    if (key.startsWith("onedrive:probe:")) {
      return redisMockState.probeReadValueOverride ?? redisMockState.probeStoredValue;
    }
    if (key.startsWith("onedrive:session:")) {
      if (redisMockState.sessionReadError) {
        throw redisMockState.sessionReadError;
      }
      return redisMockState.sessionRawValue;
    }
    if (key.startsWith("onedrive:refresh-failure:") && redisMockState.refreshFailureReadError) {
      throw redisMockState.refreshFailureReadError;
    }
    if (key.startsWith("onedrive:refresh-failure:")) {
      return redisMockState.refreshFailureValue;
    }
    if (key.startsWith("onedrive:refresh-lock:") && redisMockState.refreshLockReadError) {
      throw redisMockState.refreshLockReadError;
    }
    if (key.startsWith("onedrive:refresh-lock:")) {
      return redisMockState.refreshLockValue;
    }
    return null;
  }),
}));

import {
  ensureOAuthSessionStoreAvailable,
  getTokenForSession,
  isOAuthSessionStoreUnavailableError,
  storeTokenForSession,
  waitForRefreshOutcome,
} from "./onedrive-oauth-session.server";

describe("onedrive-oauth-session", () => {
  beforeEach(() => {
    redisMockState.deletedProbeKeys.length = 0;
    redisMockState.probeReadValueOverride = null;
    redisMockState.probeStoredValue = null;
    redisMockState.probeWriteError = null;
    redisMockState.sessionRawValue = null;
    redisMockState.refreshFailureValue = null;
    redisMockState.refreshLockValue = null;
    redisMockState.refreshFailureReadError = null;
    redisMockState.refreshLockReadError = null;
    redisMockState.sessionReadError = null;
    redisMockState.sessionDeleteError = null;
    redisMockState.deletedSessionKeys.length = 0;
    redisMockState.redisGetCallCount = 0;
  });

  it("session store preflight は write/read/delete probe を通す", async () => {
    await ensureOAuthSessionStoreAvailable();

    expect(redisMockState.deletedProbeKeys).toHaveLength(1);
    expect(redisMockState.deletedProbeKeys[0]).toMatch(/^onedrive:probe:/);
    expect(redisMockState.probeStoredValue).toBeNull();
  });

  it("session store preflight の write 障害は専用エラーに正規化する", async () => {
    redisMockState.probeWriteError = new Error("redis write denied");

    await expect(ensureOAuthSessionStoreAvailable()).rejects.toSatisfy((error: unknown) => {
      expect(isOAuthSessionStoreUnavailableError(error)).toBe(true);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Redis session store probe failed");
      expect((error as Error).message).toContain("redis write denied");
      return true;
    });
  });

  it("session store preflight の read 不整合は専用エラーに正規化する", async () => {
    redisMockState.probeReadValueOverride = "unexpected";

    await expect(ensureOAuthSessionStoreAvailable()).rejects.toSatisfy((error: unknown) => {
      expect(isOAuthSessionStoreUnavailableError(error)).toBe(true);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Redis session store probe failed");
      expect((error as Error).message).toContain("unexpected value");
      return true;
    });
  });

  it("refresh failure 読み取りの Redis 障害は専用エラーに正規化する", async () => {
    redisMockState.refreshFailureReadError = new Error("redis timed out");

    await expect(waitForRefreshOutcome("session-1", 1000)).rejects.toSatisfy((error: unknown) => {
      expect(isOAuthSessionStoreUnavailableError(error)).toBe(true);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Redis session store read-refresh-failure failed");
      expect((error as Error).message).toContain("redis timed out");
      return true;
    });
  });

  it("lock 存在中の stale refresh failure では即失敗せず、成功 token を優先する", async () => {
    const sessionId = "session-stale-failure";
    redisMockState.refreshFailureValue = "stale failure";
    redisMockState.refreshLockValue = "lock-token";

    setTimeout(() => {
      // leader 完了を模擬し、待機中followerが token を取得できる状態へ遷移させる。
      void storeTokenForSession(sessionId, {
        accessToken: "new-access-token",
        refreshToken: "refresh-token-2",
        expiresAt: Date.now() + 60_000,
      });
      redisMockState.refreshFailureValue = null;
      redisMockState.refreshLockValue = null;
    }, 20);

    await expect(waitForRefreshOutcome(sessionId, 500)).resolves.toEqual({
      kind: "token",
      token: {
        accessToken: "new-access-token",
        refreshToken: "refresh-token-2",
        expiresAt: expect.any(Number),
      },
    });
  });

  it("待機ポーリングは指数バックオフで Redis read 回数を抑える", async () => {
    vi.useFakeTimers();
    try {
      const promise = waitForRefreshOutcome("session-backoff", 500);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(promise).resolves.toBeNull();
      expect(redisMockState.redisGetCallCount).toBeLessThanOrEqual(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("session 保存時は平文tokenをRedisへ保存しない", async () => {
    await storeTokenForSession("session-encrypted", {
      accessToken: "access-token-plain",
      refreshToken: "refresh-token-plain",
      expiresAt: Date.now() + 60_000,
    });

    expect(redisMockState.sessionRawValue).toBeTruthy();
    // v1プレフィックス付きの暗号化フォーマットで保存されることを確認する。
    expect(redisMockState.sessionRawValue).toContain("v1.");
    expect(redisMockState.sessionRawValue).not.toContain("access-token-plain");
    expect(redisMockState.sessionRawValue).not.toContain("refresh-token-plain");
  });

  it("session 保存値は復号して元のTokenCacheを返せる", async () => {
    const expected = {
      accessToken: "access-token-roundtrip",
      refreshToken: "refresh-token-roundtrip",
      expiresAt: Date.now() + 60_000,
    };
    await storeTokenForSession("session-roundtrip", expected);

    await expect(getTokenForSession("session-roundtrip")).resolves.toEqual(expected);
  });

  it("session JSON 破損は 503 ではなく null を返し、破損キーを削除する", async () => {
    redisMockState.sessionRawValue = "{broken-json";
    await expect(getTokenForSession("session-corrupted-json")).resolves.toBeNull();
    expect(redisMockState.deletedSessionKeys).toContain("onedrive:session:session-corrupted-json");
  });

  it("旧平文session値は無効セッション扱いで削除する", async () => {
    redisMockState.sessionRawValue = JSON.stringify({
      accessToken: "legacy-access-token",
      refreshToken: "legacy-refresh-token",
      expiresAt: Date.now() + 60_000,
    });

    await expect(getTokenForSession("session-legacy-plaintext")).resolves.toBeNull();
    expect(redisMockState.deletedSessionKeys).toContain("onedrive:session:session-legacy-plaintext");
  });

  it("session 値が型不整合なら null を返し、破損キーを削除する", async () => {
    redisMockState.sessionRawValue = JSON.stringify({
      accessToken: 123,
      refreshToken: "refresh-token-1",
      expiresAt: Date.now() + 60_000,
    });
    await expect(getTokenForSession("session-invalid-shape")).resolves.toBeNull();
    expect(redisMockState.deletedSessionKeys).toContain("onedrive:session:session-invalid-shape");
  });

  it("破損セッション削除が失敗しても null を返す", async () => {
    redisMockState.sessionRawValue = "{broken-json";
    redisMockState.sessionDeleteError = new Error("delete failed");
    await expect(getTokenForSession("session-delete-failed")).resolves.toBeNull();
  });

  it("session read の Redis 障害だけを専用エラーに正規化する", async () => {
    redisMockState.sessionReadError = new Error("redis read timed out");
    await expect(getTokenForSession("session-read-error")).rejects.toSatisfy((error: unknown) => {
      expect(isOAuthSessionStoreUnavailableError(error)).toBe(true);
      expect((error as Error).message).toContain("Redis session store read failed");
      expect((error as Error).message).toContain("redis read timed out");
      return true;
    });
  });
});

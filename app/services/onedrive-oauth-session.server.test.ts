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
    refreshFailureReadError: null as Error | null,
  },
}));

vi.mock("./redis.server", () => ({
  redisCompareAndDelete: vi.fn(),
  redisDel: vi.fn(async (key: string) => {
    if (key.startsWith("onedrive:probe:")) {
      redisMockState.deletedProbeKeys.push(key);
      redisMockState.probeStoredValue = null;
    }
  }),
  redisSetEx: vi.fn(async (key: string, value: string) => {
    if (key.startsWith("onedrive:probe:")) {
      if (redisMockState.probeWriteError) {
        throw redisMockState.probeWriteError;
      }
      redisMockState.probeStoredValue = value;
    }
  }),
  redisSetNxPx: vi.fn(),
  redisGet: vi.fn(async (key: string) => {
    if (key.startsWith("onedrive:probe:")) {
      return redisMockState.probeReadValueOverride ?? redisMockState.probeStoredValue;
    }
    if (key.startsWith("onedrive:refresh-failure:") && redisMockState.refreshFailureReadError) {
      throw redisMockState.refreshFailureReadError;
    }
    return null;
  }),
}));

import {
  ensureOAuthSessionStoreAvailable,
  isOAuthSessionStoreUnavailableError,
  waitForRefreshOutcome,
} from "./onedrive-oauth-session.server";

describe("onedrive-oauth-session", () => {
  beforeEach(() => {
    redisMockState.deletedProbeKeys.length = 0;
    redisMockState.probeReadValueOverride = null;
    redisMockState.probeStoredValue = null;
    redisMockState.probeWriteError = null;
    redisMockState.refreshFailureReadError = null;
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
});

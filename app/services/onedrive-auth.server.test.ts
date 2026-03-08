import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { mockSessionStore } = vi.hoisted(() => ({
  mockSessionStore: new Map<string, { accessToken: string; refreshToken: string | null; expiresAt: number }>(),
}));
const { mockRefreshLocks } = vi.hoisted(() => ({
  mockRefreshLocks: new Set<string>(),
}));
const { mockRefreshFailures } = vi.hoisted(() => ({
  mockRefreshFailures: new Map<string, string>(),
}));
const { mockTryAcquireRefreshLock } = vi.hoisted(() => ({
  mockTryAcquireRefreshLock: vi.fn(async (sessionId: string, _ttlMs: number) => {
    if (mockRefreshLocks.has(sessionId)) return false;
    mockRefreshLocks.add(sessionId);
    return `lock-${sessionId}`;
  }),
}));
const { mockReleaseRefreshLock } = vi.hoisted(() => ({
  mockReleaseRefreshLock: vi.fn(async (sessionId: string) => {
    mockRefreshLocks.delete(sessionId);
  }),
}));
const { mockStoreRefreshFailure } = vi.hoisted(() => ({
  mockStoreRefreshFailure: vi.fn(async (sessionId: string, message: string) => {
    mockRefreshFailures.set(sessionId, message);
  }),
}));
const { mockWaitForRefreshOutcome } = vi.hoisted(() => ({
  mockWaitForRefreshOutcome: vi.fn(async (sessionId: string) => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const token = mockSessionStore.get(sessionId) ?? null;
      if (token?.accessToken.startsWith("new-access-token")) {
        return { kind: "token", token };
      }
      const failure = mockRefreshFailures.get(sessionId);
      if (failure) {
        return { kind: "error", message: failure };
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return null;
  }),
}));

vi.mock("./onedrive-oauth-session.server", () => ({
  OAuthSessionStoreUnavailableError: class OAuthSessionStoreUnavailableError extends Error {},
  isOAuthSessionStoreUnavailableError: (error: unknown) => error instanceof Error && error.name === "OAuthSessionStoreUnavailableError",
  ensureOAuthSessionStoreAvailable: vi.fn(async () => {}),
  storeTokenForSession: vi.fn(async (sessionId: string, cache: { accessToken: string; refreshToken: string | null; expiresAt: number }) => {
    mockSessionStore.set(sessionId, cache);
  }),
  getTokenForSession: vi.fn(async (sessionId: string | null) => (sessionId ? mockSessionStore.get(sessionId) ?? null : null)),
  deleteTokenForSession: vi.fn(async (sessionId: string) => {
    mockSessionStore.delete(sessionId);
  }),
  clearRefreshFailure: vi.fn(async (sessionId: string) => {
    mockRefreshFailures.delete(sessionId);
  }),
  storeRefreshFailure: mockStoreRefreshFailure,
  tryAcquireRefreshLock: mockTryAcquireRefreshLock,
  releaseRefreshLock: mockReleaseRefreshLock,
  waitForRefreshOutcome: mockWaitForRefreshOutcome,
}));

import {
  getAccessToken,
  isOneDriveOAuthTokenMissingError,
  OneDriveOAuthTokenMissingError,
  onedriveOAuthSessionCookie,
  persistTokenForSession,
} from "./onedrive-auth.server";

describe("onedrive-auth refresh single-flight", () => {
  beforeEach(() => {
    process.env.ONEDRIVE_CLIENT_ID = "test-client";
    process.env.ONEDRIVE_CLIENT_SECRET = "test-secret";
    process.env.ONEDRIVE_REDIRECT_URI = "https://localhost:5173/auth/onedrive/callback";
    process.env.REDIS_URL = "redis://localhost:6379/0";
  });

  afterEach(() => {
    mockSessionStore.clear();
    mockRefreshLocks.clear();
    mockRefreshFailures.clear();
    mockTryAcquireRefreshLock.mockClear();
    mockReleaseRefreshLock.mockClear();
    mockStoreRefreshFailure.mockClear();
    mockWaitForRefreshOutcome.mockClear();
    delete process.env.REDIS_URL;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("同一セッションの同時リフレッシュを1回に集約する", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    await persistTokenForSession(sessionId, {
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: Date.now() - 1000,
    });
    vi.spyOn(onedriveOAuthSessionCookie, "parse").mockResolvedValue(sessionId as never);
    const request = {
      headers: { get: (name: string) => (name.toLowerCase() === "cookie" ? "onedrive_oauth_session=stub" : null) },
    } as Request;

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-access-token",
          refresh_token: "refresh-token-2",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const tokenPromise1 = getAccessToken(request);
    const tokenPromise2 = getAccessToken(request);

    const [token1, token2] = await Promise.all([tokenPromise1, tokenPromise2]);
    expect(token1).toBe("new-access-token");
    expect(token2).toBe("new-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockTryAcquireRefreshLock).toHaveBeenCalledWith(sessionId, 185000);
    expect(mockWaitForRefreshOutcome).toHaveBeenCalledWith(sessionId, 187000);

    const token3 = await getAccessToken(request);
    expect(token3).toBe("new-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refresh タイムアウト後は single-flight ロックを解放して再試行できる", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    await persistTokenForSession(sessionId, {
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: Date.now() - 1000,
    });
    vi.spyOn(onedriveOAuthSessionCookie, "parse").mockResolvedValue(sessionId as never);
    const request = {
      headers: { get: (name: string) => (name.toLowerCase() === "cookie" ? "onedrive_oauth_session=stub" : null) },
    } as Request;

    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBeDefined();
        return Promise.reject(new DOMException("timed out", "TimeoutError"));
      })
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "new-access-token-after-timeout",
            refresh_token: "refresh-token-2",
            expires_in: 3600,
            token_type: "Bearer",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getAccessToken(request)).rejects.toThrow(/timed out after \d+ms/);
    const token = await getAccessToken(request);

    expect(token).toBe("new-access-token-after-timeout");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("先行refresh失敗時は後続も同じ失敗理由を受け取る", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    await persistTokenForSession(sessionId, {
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: Date.now() - 1000,
    });
    vi.spyOn(onedriveOAuthSessionCookie, "parse").mockResolvedValue(sessionId as never);
    const request = {
      headers: { get: (name: string) => (name.toLowerCase() === "cookie" ? "onedrive_oauth_session=stub" : null) },
    } as Request;

    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.signal).toBeDefined();
        return Promise.reject(new DOMException("timed out", "TimeoutError"));
      });
    vi.stubGlobal("fetch", fetchMock);

    const tokenPromise1 = getAccessToken(request);
    const tokenPromise2 = getAccessToken(request);

    await expect(tokenPromise1).rejects.toThrow(/timed out after \d+ms/);
    await expect(tokenPromise2).rejects.toThrow(/timed out after \d+ms/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("unlock が失敗しても refresh 成功結果を返す", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    await persistTokenForSession(sessionId, {
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: Date.now() - 1000,
    });
    vi.spyOn(onedriveOAuthSessionCookie, "parse").mockResolvedValue(sessionId as never);
    const request = {
      headers: { get: (name: string) => (name.toLowerCase() === "cookie" ? "onedrive_oauth_session=stub" : null) },
    } as Request;

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "new-access-token-after-unlock-failure",
          refresh_token: "refresh-token-2",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    mockReleaseRefreshLock.mockRejectedValueOnce(new Error("redis timeout on unlock"));

    await expect(getAccessToken(request)).resolves.toBe("new-access-token-after-unlock-failure");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockSessionStore.get(sessionId)?.accessToken).toBe("new-access-token-after-unlock-failure");
  });

  it("refreshFailure 保存が失敗しても元の refresh エラーを返す", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    await persistTokenForSession(sessionId, {
      accessToken: "expired-access",
      refreshToken: "refresh-token-1",
      expiresAt: Date.now() - 1000,
    });
    vi.spyOn(onedriveOAuthSessionCookie, "parse").mockResolvedValue(sessionId as never);
    const request = {
      headers: { get: (name: string) => (name.toLowerCase() === "cookie" ? "onedrive_oauth_session=stub" : null) },
    } as Request;

    const fetchMock = vi.fn().mockImplementationOnce((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      return Promise.reject(new DOMException("timed out", "TimeoutError"));
    });
    vi.stubGlobal("fetch", fetchMock);
    mockStoreRefreshFailure.mockRejectedValueOnce(new Error("redis write timed out"));

    await expect(getAccessToken(request)).rejects.toThrow(/timed out after \d+ms/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("session token が存在しない場合は専用エラーを返す", async () => {
    vi.spyOn(onedriveOAuthSessionCookie, "parse").mockResolvedValue("session-missing-token" as never);
    const request = {
      headers: { get: (name: string) => (name.toLowerCase() === "cookie" ? "onedrive_oauth_session=stub" : null) },
    } as Request;

    await expect(getAccessToken(request)).rejects.toSatisfy((error: unknown) => {
      expect(error).toBeInstanceOf(OneDriveOAuthTokenMissingError);
      expect(isOneDriveOAuthTokenMissingError(error)).toBe(true);
      return true;
    });
  });
});

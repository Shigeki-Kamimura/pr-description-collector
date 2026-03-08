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
import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { resolvedSessionSecret } from "./session-secret.server";

const { testCryptoConfig } = vi.hoisted(() => {
  const testCryptoConfig = {
    currentKeyVersion: "k-current",
    currentKeyMaterial: "test-current-material",
    previousKeyVersion: "k-previous",
    previousKeyMaterial: "test-previous-material",
  };
  process.env.ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_VERSION = testCryptoConfig.currentKeyVersion;
  process.env.ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_MATERIAL = testCryptoConfig.currentKeyMaterial;
  process.env.ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION = testCryptoConfig.previousKeyVersion;
  process.env.ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_MATERIAL = testCryptoConfig.previousKeyMaterial;
  return { testCryptoConfig };
});

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

const { mockLoggerWarn } = vi.hoisted(() => ({
  mockLoggerWarn: vi.fn(),
}));

function encryptMalformedSessionPayload(payload: unknown): string {
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(testCryptoConfig.currentKeyMaterial, "utf8"),
      Buffer.from(testCryptoConfig.currentKeyVersion, "utf8"),
      "onedrive-oauth-token-encryption",
      32,
    ),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ["v1", testCryptoConfig.currentKeyVersion, iv.toString("base64url"), authTag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function encryptVersionedSessionPayload(payload: unknown, keyVersion: string, keyMaterial: string): string {
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      Buffer.from(keyMaterial, "utf8"),
      Buffer.from(keyVersion, "utf8"),
      "onedrive-oauth-token-encryption",
      32,
    ),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ["v1", keyVersion, iv.toString("base64url"), authTag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

function encryptLegacySessionPayload(payload: unknown): string {
  const key = createHash("sha256").update(resolvedSessionSecret, "utf8").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), authTag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

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

vi.mock("./logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
  },
}));

import {
  isOAuthSessionTokenCryptoError,
  ensureOAuthSessionStoreAvailable,
  getTokenForSession,
  isOAuthSessionStoreUnavailableError,
  OAuthSessionTokenCryptoError,
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
    mockLoggerWarn.mockReset();
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
    // v1.keyVersion プレフィックス付きの暗号化フォーマットで保存されることを確認する。
    expect(redisMockState.sessionRawValue).toContain(`v1.${testCryptoConfig.currentKeyVersion}.`);
    expect(redisMockState.sessionRawValue).not.toContain("access-token-plain");
    expect(redisMockState.sessionRawValue).not.toContain("refresh-token-plain");
  });

  it("session 暗号化失敗は Redis 障害エラーに包まず専用エラーで返す", async () => {
    const concatSpy = vi.spyOn(Buffer, "concat").mockImplementationOnce(() => {
      throw new Error("cipher failed");
    });
    try {
      await expect(
        storeTokenForSession("session-encrypt-error", {
          accessToken: "access-token",
          refreshToken: "refresh-token",
          expiresAt: Date.now() + 60_000,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(isOAuthSessionStoreUnavailableError(error)).toBe(false);
        expect(isOAuthSessionTokenCryptoError(error)).toBe(true);
        expect(error).toBeInstanceOf(OAuthSessionTokenCryptoError);
        expect((error as Error).message).toContain("OneDrive token crypto encrypt failed");
        return true;
      });
    } finally {
      concatSpy.mockRestore();
    }
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

  it("復号失敗時は生sessionIdを含めず reason/cause を警告ログへ残す", async () => {
    redisMockState.sessionRawValue = [
      "v1",
      Buffer.alloc(12).toString("base64url"),
      Buffer.alloc(16).toString("base64url"),
      Buffer.from("tampered-ciphertext", "utf8").toString("base64url"),
    ].join(".");
    const sessionId = "session-decrypt-log";
    await expect(getTokenForSession(sessionId)).resolves.toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Discarding invalid OneDrive OAuth session token.",
      expect.objectContaining({
        sessionIdHash: expect.stringMatching(/^[0-9a-f]{12}$/),
        reason: "decrypt-failed",
        cause: "auth-failed",
      }),
    );
    const warnPayload = mockLoggerWarn.mock.calls[0]?.[1];
    expect(warnPayload).not.toHaveProperty("sessionId");
    expect(JSON.stringify(warnPayload)).not.toContain(sessionId);
  });

  it("previous key version で暗号化された値も復号できる", async () => {
    const expected = {
      accessToken: "access-token-previous",
      refreshToken: "refresh-token-previous",
      expiresAt: Date.now() + 60_000,
    };
    redisMockState.sessionRawValue = encryptVersionedSessionPayload(
      expected,
      testCryptoConfig.previousKeyVersion,
      testCryptoConfig.previousKeyMaterial,
    );

    await expect(getTokenForSession("session-previous-key")).resolves.toEqual(expected);
  });

  it("旧4セグメント形式（sha256導出鍵）でも復号できる", async () => {
    const expected = {
      accessToken: "access-token-legacy-format",
      refreshToken: "refresh-token-legacy-format",
      expiresAt: Date.now() + 60_000,
    };
    redisMockState.sessionRawValue = encryptLegacySessionPayload(expected);

    await expect(getTokenForSession("session-legacy-format")).resolves.toEqual(expected);
  });

  it("未対応 key version は無効セッション扱いで削除する", async () => {
    redisMockState.sessionRawValue = encryptVersionedSessionPayload(
      {
        accessToken: "access-token-unknown-key",
        refreshToken: "refresh-token-unknown-key",
        expiresAt: Date.now() + 60_000,
      },
      "k-unknown",
      "unknown-material",
    );

    await expect(getTokenForSession("session-unknown-key-version")).resolves.toBeNull();
    expect(redisMockState.deletedSessionKeys).toContain("onedrive:session:session-unknown-key-version");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Discarding invalid OneDrive OAuth session token.",
      expect.objectContaining({ reason: "unknown-key-version" }),
    );
  });

  it("復号前バリデーション失敗では cause を付けない", async () => {
    redisMockState.sessionRawValue = "legacy-plaintext";
    await expect(getTokenForSession("session-invalid-format")).resolves.toBeNull();
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Discarding invalid OneDrive OAuth session token.",
      expect.objectContaining({
        reason: "invalid-segment-count",
      }),
    );
    const warnPayload = mockLoggerWarn.mock.calls[0]?.[1];
    expect(warnPayload).not.toHaveProperty("cause");
  });

  it("accessToken 型不整合は無効セッション扱いで削除する", async () => {
    redisMockState.sessionRawValue = encryptMalformedSessionPayload({
      accessToken: 123,
      refreshToken: "refresh-token-1",
      expiresAt: Date.now() + 60_000,
    });
    await expect(getTokenForSession("session-invalid-access-token-type")).resolves.toBeNull();
    expect(redisMockState.deletedSessionKeys).toContain("onedrive:session:session-invalid-access-token-type");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Discarding invalid OneDrive OAuth session token.",
      expect.objectContaining({ reason: "invalid-access-token-type" }),
    );
  });

  it("refreshToken 型不整合は無効セッション扱いで削除する", async () => {
    redisMockState.sessionRawValue = encryptMalformedSessionPayload({
      accessToken: "access-token",
      refreshToken: 123,
      expiresAt: Date.now() + 60_000,
    });
    await expect(getTokenForSession("session-invalid-refresh-token-type")).resolves.toBeNull();
    expect(redisMockState.deletedSessionKeys).toContain("onedrive:session:session-invalid-refresh-token-type");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Discarding invalid OneDrive OAuth session token.",
      expect.objectContaining({ reason: "invalid-refresh-token-type" }),
    );
  });

  it("expiresAt 型不整合は無効セッション扱いで削除する", async () => {
    redisMockState.sessionRawValue = encryptMalformedSessionPayload({
      accessToken: "access-token",
      refreshToken: "refresh-token-1",
      expiresAt: "invalid",
    });
    await expect(getTokenForSession("session-invalid-expires-at")).resolves.toBeNull();
    expect(redisMockState.deletedSessionKeys).toContain("onedrive:session:session-invalid-expires-at");
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "Discarding invalid OneDrive OAuth session token.",
      expect.objectContaining({ reason: "invalid-expires-at" }),
    );
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

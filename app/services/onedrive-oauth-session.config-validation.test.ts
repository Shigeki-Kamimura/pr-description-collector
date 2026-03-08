import { afterEach, describe, expect, it, vi } from "vitest";

type EnvSnapshot = Record<string, string | undefined>;

const ENV_KEYS = [
  "NODE_ENV",
  "SESSION_SECRET",
  "ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_VERSION",
  "ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_MATERIAL",
  "ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION",
  "ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_MATERIAL",
] as const;

function snapshotEnv(): EnvSnapshot {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

function setBaseEnv(): void {
  process.env.NODE_ENV = "test";
  process.env.SESSION_SECRET = "session-secret-for-config-validation-test";
  delete process.env.ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_VERSION;
  delete process.env.ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_MATERIAL;
  delete process.env.ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION;
  delete process.env.ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_MATERIAL;
}

async function importSessionModule() {
  vi.resetModules();
  return import("./onedrive-oauth-session.server");
}

describe("onedrive-oauth-session key version validation", () => {
  const originalEnv = snapshotEnv();

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it.each(["k1", "k-current", "K_CURRENT_2026", "rotA_1-2"])(
    "current key version '%s' は許容される",
    async (version) => {
      setBaseEnv();
      process.env.ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_VERSION = version;
      process.env.ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_MATERIAL = "current-key-material";

      await expect(importSessionModule()).resolves.toBeTruthy();
    },
  );

  it.each(["k.1", "k 1", "k/1", "日本語"])("current key version '%s' は拒否される", async (version) => {
    setBaseEnv();
    process.env.ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_VERSION = version;
    process.env.ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_MATERIAL = "current-key-material";

    await expect(importSessionModule()).rejects.toThrow(
      `ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_VERSION の値 "${version}" は無効です。`,
    );
  });

  it.each(["prev.1", "prev 1", "prev/1", "旧鍵"])("previous key version '%s' は拒否される", async (version) => {
    setBaseEnv();
    process.env.ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_VERSION = "k1";
    process.env.ONEDRIVE_TOKEN_ENCRYPTION_CURRENT_KEY_MATERIAL = "current-key-material";
    process.env.ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION = version;
    process.env.ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_MATERIAL = "previous-key-material";

    await expect(importSessionModule()).rejects.toThrow(
      `ONEDRIVE_TOKEN_ENCRYPTION_PREVIOUS_KEY_VERSION の値 "${version}" は無効です。`,
    );
  });
});

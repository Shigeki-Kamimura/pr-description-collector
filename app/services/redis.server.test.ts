/**
 * Redis 接続ユーティリティのテスト
 *
 * このファイルを用意した理由:
 * - Redis connect / command timeout 時に socket が確実に cleanup される契約を固定するため。
 *
 * このファイルが使われる場面:
 * - Redis 障害時に socket leak を起こさないことを確認するとき。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSocketState } = vi.hoisted(() => ({
  mockSocketState: {
    mode: "connect-timeout" as "connect-timeout" | "command-timeout" | "post-connect-sync-error",
    sockets: [] as Array<{ destroyedByTest: boolean; endedByTest: boolean }>,
  },
}));

vi.mock("node:net", async () => {
  const { EventEmitter } = await import("node:events");
  class MockSocket extends EventEmitter {
    destroyedByTest = false;
    endedByTest = false;

    constructor() {
      super();
      mockSocketState.sockets.push(this);
    }

    connect(_port: number, _host: string) {
      if (mockSocketState.mode === "command-timeout") {
        setTimeout(() => {
          this.emit("connect");
        }, 0);
      } else if (mockSocketState.mode === "post-connect-sync-error") {
        this.emit("connect");
        this.emit("error", new Error("ECONNRESET after connect"));
      }
      return this;
    }

    write(_chunk: Buffer) {
      return true;
    }

    destroy() {
      this.destroyedByTest = true;
      this.emit("close");
      return this;
    }

    end() {
      this.endedByTest = true;
      this.emit("close");
      return this;
    }
  }

  return { Socket: MockSocket };
});

vi.mock("node:tls", async () => {
  const { EventEmitter } = await import("node:events");
  class MockTlsSocket extends EventEmitter {
    destroyedByTest = false;
    endedByTest = false;

    constructor() {
      super();
      mockSocketState.sockets.push(this);
    }

    write(_chunk: Buffer) {
      return true;
    }

    destroy() {
      this.destroyedByTest = true;
      this.emit("close");
      return this;
    }

    end() {
      this.endedByTest = true;
      this.emit("close");
      return this;
    }
  }

  return {
    connect: vi.fn(() => new MockTlsSocket()),
  };
});

import { redisPing } from "./redis.server";

describe("redis.server timeout cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.REDIS_URL = "redis://localhost:6379/0";
    process.env.REDIS_TIMEOUT_MS = "10";
    mockSocketState.sockets.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.REDIS_URL;
    delete process.env.REDIS_TIMEOUT_MS;
    mockSocketState.sockets.length = 0;
  });

  it("connect timeout時はsocketをdestroyする", async () => {
    mockSocketState.mode = "connect-timeout";

    const promise = redisPing();
    const rejection = expect(promise).rejects.toThrow("Redis connect timed out after 10ms");
    await vi.advanceTimersByTimeAsync(11);

    await rejection;
    expect(mockSocketState.sockets).toHaveLength(1);
    expect(mockSocketState.sockets[0].destroyedByTest).toBe(true);
  });

  it("command timeout時はsocketをdestroyする", async () => {
    mockSocketState.mode = "command-timeout";

    const promise = redisPing();
    const rejection = expect(promise).rejects.toThrow("Redis command timed out after 10ms");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(mockSocketState.sockets).toHaveLength(1);
    expect(mockSocketState.sockets[0].destroyedByTest).toBe(true);
    expect(mockSocketState.sockets[0].endedByTest).toBe(false);
  });

  it("connect直後の同期errorは timeout まで待たずに即失敗する", async () => {
    mockSocketState.mode = "post-connect-sync-error";

    await expect(redisPing()).rejects.toThrow("ECONNRESET after connect");
    expect(mockSocketState.sockets).toHaveLength(1);
    expect(mockSocketState.sockets[0].destroyedByTest).toBe(true);
  });

  it("REDIS_URL の port が範囲外なら明確な設定エラーを返す", async () => {
    process.env.REDIS_URL = "redis://localhost:0/0";

    await expect(redisPing()).rejects.toThrow("REDIS_URL port is invalid. Use an integer between 1 and 65535.");
    expect(mockSocketState.sockets).toHaveLength(0);
  });

  it("password に % が含まれても URIError にならず接続処理へ進む", async () => {
    mockSocketState.mode = "command-timeout";
    process.env.REDIS_URL = "redis://user:pa%ss@localhost:6379/0";

    const promise = redisPing();
    const rejection = expect(promise).rejects.toThrow("Redis command timed out after 10ms");
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(10);

    await rejection;
    expect(mockSocketState.sockets).toHaveLength(1);
    expect(mockSocketState.sockets[0].destroyedByTest).toBe(true);
  });
});

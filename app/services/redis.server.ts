/**
 * Redis 接続ユーティリティ
 *
 * このファイルを用意した理由:
 * - OneDrive OAuth のサーバー側セッションを Redis に保存するための最小クライアントをまとめるため。
 * - 依存追加に頼らず、必要な Redis コマンドだけを明示的に扱うため。
 *
 * このファイルが使われる場面:
 * - OAuth セッション保存・参照・削除を行うとき。
 * - token refresh の分散ロックを取得・解放するとき。
 * - OAuth 開始前に Redis 疎通を確認するとき。
 */
import { Socket } from "node:net";
import { connect as connectTls } from "node:tls";
import type { TLSSocket } from "node:tls";

const DEFAULT_REDIS_TIMEOUT_MS = 3000;

type RedisEndpoint = {
  host: string;
  port: number;
  db: number;
  username: string | null;
  password: string | null;
  tls: boolean;
};

// 今回使う RESP の最小表現。bulk string / integer / array だけ扱えれば必要コマンドを解釈できる。
type RespValue = string | null | number | RespValue[];
const SOCKET_CONNECT_PHASE_ERROR = Symbol("socket-connect-phase-error");
type SocketWithConnectPhaseError = (Socket | TLSSocket) & {
  [SOCKET_CONNECT_PHASE_ERROR]?: Error;
};

// Redis の RESP 応答を逐次パースし、ソケットの chunk 分割を吸収する。
class RespParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
  }

  tryParse(): { value: RespValue; consumed: number } | null {
    return this.parseAt(0);
  }

  consume(length: number) {
    this.buffer = this.buffer.subarray(length);
  }

  // 先頭1文字の marker を見て、RESP 型ごとのパーサーへ振り分ける。
  private parseAt(offset: number): { value: RespValue; consumed: number } | null {
    if (this.buffer.length <= offset) return null;
    const marker = String.fromCharCode(this.buffer[offset]);
    switch (marker) {
      case "+":
        return this.parseSimpleString(offset);
      case "-":
        return this.parseError(offset);
      case ":":
        return this.parseInteger(offset);
      case "$":
        return this.parseBulkString(offset);
      case "*":
        return this.parseArray(offset);
      default:
        throw new Error(`Unsupported Redis RESP marker: ${marker}`);
    }
  }

  private parseLine(offset: number): { value: string; end: number } | null {
    const end = this.buffer.indexOf("\r\n", offset);
    if (end === -1) return null;
    return {
      value: this.buffer.toString("utf8", offset, end),
      end: end + 2,
    };
  }

  private parseSimpleString(offset: number): { value: string; consumed: number } | null {
    const line = this.parseLine(offset + 1);
    if (!line) return null;
    return { value: line.value, consumed: line.end - offset };
  }

  private parseError(offset: number): never | null {
    const line = this.parseLine(offset + 1);
    if (!line) return null;
    throw new Error(`Redis error: ${line.value}`);
  }

  private parseInteger(offset: number): { value: number; consumed: number } | null {
    const line = this.parseLine(offset + 1);
    if (!line) return null;
    return { value: Number.parseInt(line.value, 10), consumed: line.end - offset };
  }

  private parseBulkString(offset: number): { value: string | null; consumed: number } | null {
    const line = this.parseLine(offset + 1);
    if (!line) return null;
    const length = Number.parseInt(line.value, 10);
    if (length === -1) {
      return { value: null, consumed: line.end - offset };
    }
    const bodyStart = line.end;
    const bodyEnd = bodyStart + length;
    if (this.buffer.length < bodyEnd + 2) return null;
    return {
      value: this.buffer.toString("utf8", bodyStart, bodyEnd),
      consumed: bodyEnd + 2 - offset,
    };
  }

  private parseArray(offset: number): { value: RespValue[]; consumed: number } | null {
    const line = this.parseLine(offset + 1);
    if (!line) return null;
    const length = Number.parseInt(line.value, 10);
    if (length === -1) {
      return { value: [], consumed: line.end - offset };
    }

    let cursor = line.end;
    const values: RespValue[] = [];
    for (let i = 0; i < length; i++) {
      const parsed = this.parseAt(cursor);
      if (!parsed) return null;
      values.push(parsed.value);
      cursor += parsed.consumed;
    }
    return { value: values, consumed: cursor - offset };
  }
}

function getRedisTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.REDIS_TIMEOUT_MS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_REDIS_TIMEOUT_MS;
  return parsed;
}

// redis:// / rediss:// を環境変数から解決し、接続に必要な要素へ分解する。
function getRedisEndpoint(): RedisEndpoint | null {
  const raw = process.env.REDIS_URL?.trim() ?? "";
  if (!raw) return null;

  const url = new URL(raw);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error("REDIS_URL must use redis:// or rediss://");
  }

  const dbPath = url.pathname;
  if (dbPath !== "/" && !/^\/\d+$/.test(dbPath)) {
    throw new Error("REDIS_URL database index is invalid. Use /<non-negative-integer>.");
  }
  const db = dbPath === "/" ? 0 : Number.parseInt(dbPath.slice(1), 10);
  if (!Number.isFinite(db) || db < 0) {
    throw new Error("REDIS_URL database index is invalid");
  }

  return {
    host: url.hostname || "127.0.0.1",
    port: (() => {
      if (!url.port) return 6379;
      const parsedPort = Number.parseInt(url.port, 10);
      if (!Number.isFinite(parsedPort) || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error("REDIS_URL port is invalid. Use an integer between 1 and 65535.");
      }
      return parsedPort;
    })(),
    db,
    username: url.username || null,
    password: url.password || null,
    tls: url.protocol === "rediss:",
  };
}

// Redis コマンドを RESP 配列形式へエンコードしてソケットへ流せる形にする。
function encodeCommand(parts: string[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${parts.length}\r\n`, "utf8")];
  for (const part of parts) {
    const body = Buffer.from(part, "utf8");
    chunks.push(Buffer.from(`$${body.length}\r\n`, "utf8"));
    chunks.push(body);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  return Buffer.concat(chunks);
}

// Redis への平文/TLS 接続差分をここで吸収し、以降の送受信処理を単純化する。
function openSocket(endpoint: RedisEndpoint, timeoutMs: number): Promise<Socket | TLSSocket> {
  return new Promise<Socket | TLSSocket>((resolve, reject) => {
    let settled = false;
    const socket = endpoint.tls
      ? connectTls({ host: endpoint.host, port: endpoint.port, servername: endpoint.host })
      : new Socket();
    const connectEventName = endpoint.tls ? "secureConnect" : "connect";
    // connect 完了直後の一瞬で error が飛んでも未処理化しないよう、常駐ガードを置く。
    const onErrorGuard = () => {};
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(connectEventName, onConnect);
      socket.off("close", onClose);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onError = (error: Error) => {
      if (!settled) {
        settle(() => {
          socket.destroy();
          reject(error);
        });
        return;
      }
      // connect 完了直後に飛ぶ error は runSequence 側へ即伝搬できるよう保持する。
      const socketWithError = socket as SocketWithConnectPhaseError;
      socketWithError[SOCKET_CONNECT_PHASE_ERROR] = error;
      socket.destroy();
    };
    const onConnect = () => {
      settle(() => {
        resolve(socket);
      });
    };
    const onClose = () => {
      settle(() => {
        reject(new Error("Redis connection closed before connect completed"));
      });
    };
    const timer = setTimeout(() => {
      settle(() => {
        socket.destroy();
        reject(new Error(`Redis connect timed out after ${timeoutMs}ms`));
      });
    }, timeoutMs);

    socket.on("error", onErrorGuard);
    socket.once("error", onError);
    socket.once(connectEventName, onConnect);
    socket.once("close", onClose);
    if (!endpoint.tls) {
      socket.connect(endpoint.port, endpoint.host);
    }
  });
}

// AUTH/SELECT を含めた複数コマンドを 1 接続で順に流し、RESP でまとめて回収する。
async function runSequence(sequence: string[][]): Promise<RespValue[]> {
  const endpoint = getRedisEndpoint();
  if (!endpoint) {
    throw new Error("REDIS_URL is not configured");
  }

  const timeoutMs = getRedisTimeoutMs();
  const commands: string[][] = [];
  if (endpoint.password) {
    commands.push(
      endpoint.username
        ? ["AUTH", endpoint.username, endpoint.password]
        : ["AUTH", endpoint.password],
    );
  }
  if (endpoint.db !== 0) {
    commands.push(["SELECT", String(endpoint.db)]);
  }
  commands.push(...sequence);

  const socket = await openSocket(endpoint, timeoutMs);
  const connectPhaseError = (socket as SocketWithConnectPhaseError)[SOCKET_CONNECT_PHASE_ERROR];
  if (connectPhaseError) {
    throw connectPhaseError;
  }
  const parser = new RespParser();
  const values: RespValue[] = [];

  return await new Promise<RespValue[]>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const finish = (value: RespValue[]) => {
      settle(() => {
        socket.end();
        resolve(value);
      });
    };
    const fail = (error: Error) => {
      settle(() => {
        socket.destroy();
        reject(error);
      });
    };
    const onData = (chunk: Buffer) => {
      try {
        parser.push(chunk);
        while (values.length < commands.length) {
          const parsed = parser.tryParse();
          if (!parsed) break;
          parser.consume(parsed.consumed);
          values.push(parsed.value);
        }
        if (values.length === commands.length) {
          finish(values);
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onError = (error: Error) => fail(error);
    const onClose = () => {
      if (values.length < commands.length) {
        fail(new Error("Redis connection closed before full response was received"));
      }
    };
    const timer = setTimeout(() => {
      fail(new Error(`Redis command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    for (const command of commands) {
      socket.write(encodeCommand(command));
    }
  });
}

export async function redisPing(): Promise<void> {
  await runSequence([["PING"]]);
}

export async function redisGet(key: string): Promise<string | null> {
  const values = await runSequence([["GET", key]]);
  const value = values.at(-1);
  return typeof value === "string" ? value : null;
}

export async function redisSetEx(key: string, value: string, ttlSeconds: number): Promise<void> {
  await runSequence([["SET", key, value, "EX", String(ttlSeconds)]]);
}

export async function redisDel(key: string): Promise<void> {
  await runSequence([["DEL", key]]);
}

export async function redisSetNxPx(key: string, value: string, ttlMs: number): Promise<boolean> {
  const values = await runSequence([["SET", key, value, "NX", "PX", String(ttlMs)]]);
  return values.at(-1) === "OK";
}

// refresh ロック解放時に他 worker のロックを消さないよう compare-and-delete する。
export async function redisCompareAndDelete(key: string, expectedValue: string): Promise<boolean> {
  const values = await runSequence([
    [
      "EVAL",
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      "1",
      key,
      expectedValue,
    ],
  ]);
  return values.at(-1) === 1;
}

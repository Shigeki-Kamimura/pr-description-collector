/**
 * HTTPS判定ユーティリティの回帰テスト
 *
 * このファイルを作った理由:
 * - nginx などの HTTPS 終端プロキシ配下で、公開側 host:port を正しく引き継がないと
 *   OneDrive OAuth が 400 で失敗する経路を固定するため。
 *
 * このファイルが使われる場面:
 * - proxy ヘッダーや trusted host 判定を変更したとき。
 * - compose / nginx 設定変更で OneDrive OAuth の HTTPS 判定互換性を確認したいとき。
 */
import { afterEach, describe, expect, it } from "vitest";
import { isHttpsRequest } from "./https-validation.server";

type EnvSnapshot = Record<string, string | undefined>;

const ENV_KEYS = [
  "ONEDRIVE_TRUST_X_FORWARDED_PROTO",
  "ONEDRIVE_TRUSTED_PROXY_HOSTS",
  "ONEDRIVE_TRUST_PROXY_SHARED_SECRET",
] as const;

// HTTPS 判定に影響する env だけを退避し、他テストへのリークを防ぐ。
function snapshotEnv(): EnvSnapshot {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

// undefined は削除、それ以外は復元して import 時の設定差分を残さない。
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

describe("isHttpsRequest", () => {
  const originalEnv = snapshotEnv();

  afterEach(() => {
    restoreEnv(originalEnv);
  });

  it("プロキシが公開 host:port を保持していれば HTTPS と判定する", () => {
    process.env.ONEDRIVE_TRUST_X_FORWARDED_PROTO = "true";
    process.env.ONEDRIVE_TRUSTED_PROXY_HOSTS = "localhost:15173";

    const request = new Request("http://app:3000/auth/onedrive/login", {
      headers: {
        host: "localhost:15173",
        "x-forwarded-host": "localhost:15173",
        "x-forwarded-proto": "https",
      },
    });

    expect(isHttpsRequest(request)).toBe(true);
  });

  it("プロキシが内部 listen port を渡すと trusted host と一致せず拒否する", () => {
    process.env.ONEDRIVE_TRUST_X_FORWARDED_PROTO = "true";
    process.env.ONEDRIVE_TRUSTED_PROXY_HOSTS = "localhost:15173";

    const request = new Request("http://app:3000/auth/onedrive/login", {
      headers: {
        host: "localhost:443",
        "x-forwarded-host": "localhost:443",
        "x-forwarded-proto": "https",
      },
    });

    expect(isHttpsRequest(request)).toBe(false);
  });
});

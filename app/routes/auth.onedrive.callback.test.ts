/**
 * OneDrive OAuth callback ルートのテスト
 *
 * このファイルを用意した理由:
 * - OAuth失敗時にトップへ戻し、内部エラー詳細をクライアントへ露出しない契約を
 *   ルート単位でロックするため。
 *
 * このファイルが使われる場面:
 * - `npm run test` 実行時に、callback失敗時のリダイレクト契約を確認するとき。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader } from "./auth.onedrive.callback";
import {
  exchangeCodeForToken,
  onedriveOAuthBindCookie,
  onedriveOAuthStateCookie,
  persistTokenForSession,
} from "../services/onedrive-auth.server";
import { ensureOAuthSessionStoreAvailable } from "../services/onedrive-oauth-session.server";

vi.mock("../services/onedrive-auth.server", () => ({
  exchangeCodeForToken: vi.fn(),
  onedriveOAuthStateCookie: {
    parse: vi.fn(),
    serialize: vi.fn(async () => "state=; Max-Age=0"),
  },
  onedriveOAuthBindCookie: {
    parse: vi.fn(),
    serialize: vi.fn(async () => "bind=; Max-Age=0"),
  },
  onedriveOAuthSessionCookie: {
    serialize: vi.fn(async () => "session=test"),
  },
  persistTokenForSession: vi.fn(),
}));

vi.mock("../services/onedrive-oauth-session.server", () => ({
  OAuthSessionStoreUnavailableError: class OAuthSessionStoreUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "OAuthSessionStoreUnavailableError";
    }
  },
  ensureOAuthSessionStoreAvailable: vi.fn(async () => {}),
  isOAuthSessionStoreUnavailableError: (error: unknown) =>
    error instanceof Error && error.name === "OAuthSessionStoreUnavailableError",
}));

describe("auth.onedrive.callback loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("HTTPアクセスは400で拒否する", async () => {
    const request = new Request("http://localhost:5173/auth/onedrive/callback?code=x&state=y");

    const response = await loader({ request });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("Secure Cookie is unavailable on HTTP");
  });

  it("OAuth provider error時はトップへリダイレクトする", async () => {
    const request = new Request(
      "https://localhost:5173/auth/onedrive/callback?error=access_denied&error_description=sensitive-details&error_codes=12345",
    );

    const response = await loader({ request });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/?onedrive=oauth_failed");
  });

  it("token交換失敗時はトップへリダイレクトする", async () => {
    vi.mocked(onedriveOAuthStateCookie.parse).mockResolvedValue("bind-a.nonce-1");
    vi.mocked(onedriveOAuthBindCookie.parse).mockResolvedValue("bind-a");
    vi.mocked(exchangeCodeForToken).mockRejectedValue(new Error("sensitive-token-error"));

    const request = new Request(
      "https://localhost:5173/auth/onedrive/callback?code=test-code&state=bind-a.nonce-1",
      { headers: { Cookie: "onedrive_oauth_state=stub" } },
    );

    const response = await loader({ request });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/?onedrive=oauth_failed");
  });

  it("Redis障害時は503で停止する", async () => {
    vi.mocked(onedriveOAuthStateCookie.parse).mockResolvedValue("bind-a.nonce-1");
    vi.mocked(onedriveOAuthBindCookie.parse).mockResolvedValue("bind-a");
    vi.mocked(ensureOAuthSessionStoreAvailable).mockRejectedValue(
      new (class OAuthSessionStoreUnavailableError extends Error {
        constructor() {
          super("redis down");
          this.name = "OAuthSessionStoreUnavailableError";
        }
      })(),
    );

    const request = new Request(
      "https://localhost:5173/auth/onedrive/callback?code=test-code&state=bind-a.nonce-1",
      { headers: { Cookie: "onedrive_oauth_state=stub; onedrive_oauth_bind=stub" } },
    );

    const response = await loader({ request });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("OneDrive 認証基盤で一時障害");
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
    expect(persistTokenForSession).not.toHaveBeenCalled();
  });

  it("stateとbind cookieの整合が取れない場合はトップへ戻す", async () => {
    vi.mocked(onedriveOAuthStateCookie.parse).mockResolvedValue("bind-a.nonce-1");
    vi.mocked(onedriveOAuthBindCookie.parse).mockResolvedValue("bind-b");

    const request = new Request(
      "https://localhost:5173/auth/onedrive/callback?code=test-code&state=bind-a.nonce-1",
      { headers: { Cookie: "onedrive_oauth_state=stub; onedrive_oauth_bind=stub" } },
    );

    const response = await loader({ request });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/?onedrive=oauth_failed");
  });

  it("state に区切りドットがない場合もトップへ戻す", async () => {
    vi.mocked(onedriveOAuthStateCookie.parse).mockResolvedValue("bind-a");
    vi.mocked(onedriveOAuthBindCookie.parse).mockResolvedValue("bind-a");

    const request = new Request(
      "https://localhost:5173/auth/onedrive/callback?code=test-code&state=bind-a",
      { headers: { Cookie: "onedrive_oauth_state=stub; onedrive_oauth_bind=stub" } },
    );

    const response = await loader({ request });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/?onedrive=oauth_failed");
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("token保存失敗時は再認証案内の503を返し、state/bind cookie をクリアする", async () => {
    vi.mocked(ensureOAuthSessionStoreAvailable).mockResolvedValue(undefined);
    vi.mocked(onedriveOAuthStateCookie.parse).mockResolvedValue("bind-a.nonce-1");
    vi.mocked(onedriveOAuthBindCookie.parse).mockResolvedValue("bind-a");
    vi.mocked(exchangeCodeForToken).mockResolvedValue({
      accessToken: "access-token-1",
      refreshToken: "refresh-token-1",
      expiresAt: Date.now() + 60_000,
    });
    vi.mocked(persistTokenForSession).mockRejectedValue(
      new (class OAuthSessionStoreUnavailableError extends Error {
        constructor() {
          super("redis down on persist");
          this.name = "OAuthSessionStoreUnavailableError";
        }
      })(),
    );

    const request = new Request(
      "https://localhost:5173/auth/onedrive/callback?code=test-code&state=bind-a.nonce-1",
      { headers: { Cookie: "onedrive_oauth_state=stub; onedrive_oauth_bind=stub" } },
    );

    const response = await loader({ request });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("Connect OneDrive から認証をやり直してください");
    expect(exchangeCodeForToken).toHaveBeenCalledTimes(1);
    expect(persistTokenForSession).toHaveBeenCalledTimes(1);
    expect(onedriveOAuthStateCookie.serialize).toHaveBeenCalledWith("", { maxAge: 0 });
    expect(onedriveOAuthBindCookie.serialize).toHaveBeenCalledWith("", { maxAge: 0 });
  });
});

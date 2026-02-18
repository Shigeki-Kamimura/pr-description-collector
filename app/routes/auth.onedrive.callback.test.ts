/**
 * OneDrive OAuth callback ルートのテスト
 *
 * このファイルを用意した理由:
 * - OAuth失敗時に内部エラー詳細をクライアントへ露出しないという要件を
 *   ルート単位でロックするため。
 *
 * このファイルが使われる場面:
 * - `npm run test` 実行時に、callbackのエラーレスポンスが定型文へサニタイズされることを確認するとき。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader } from "./auth.onedrive.callback";
import {
  exchangeCodeForToken,
  onedriveOAuthStateCookie,
} from "../services/onedrive-auth.server";

vi.mock("../services/onedrive-auth.server", () => ({
  exchangeCodeForToken: vi.fn(),
  onedriveOAuthStateCookie: {
    parse: vi.fn(),
    serialize: vi.fn(async () => "state=; Max-Age=0"),
  },
  onedriveOAuthSessionCookie: {
    serialize: vi.fn(async () => "session=test"),
  },
  storeTokenForSession: vi.fn(),
}));

describe("auth.onedrive.callback loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("OAuth provider errorの詳細をレスポンスへ露出しない", async () => {
    const request = new Request(
      "https://localhost:5173/auth/onedrive/callback?error=access_denied&error_description=sensitive-details&error_codes=12345",
    );

    const response = await loader({ request });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("OneDrive 認証に失敗しました。Connect OneDrive から再試行してください。");
    expect(body).toContain("[codes: 12345]");
    expect(body).not.toContain("sensitive-details");
  });

  it("token交換失敗時に内部詳細をレスポンスへ露出しない", async () => {
    vi.mocked(onedriveOAuthStateCookie.parse).mockResolvedValue("state-1");
    vi.mocked(exchangeCodeForToken).mockRejectedValue(new Error("sensitive-token-error"));

    const request = new Request(
      "https://localhost:5173/auth/onedrive/callback?code=test-code&state=state-1",
      { headers: { Cookie: "onedrive_oauth_state=stub" } },
    );

    const response = await loader({ request });
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).toBe("OneDrive 認証に失敗しました。Connect OneDrive から再試行してください。");
    expect(body).not.toContain("sensitive-token-error");
  });
});

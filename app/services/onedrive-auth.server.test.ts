import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAccessToken,
  onedriveOAuthSessionCookie,
  storeTokenForSession,
} from "./onedrive-auth.server";

describe("onedrive-auth refresh single-flight", () => {
  beforeEach(() => {
    process.env.ONEDRIVE_CLIENT_ID = "test-client";
    process.env.ONEDRIVE_CLIENT_SECRET = "test-secret";
    process.env.ONEDRIVE_REDIRECT_URI = "https://localhost:5173/auth/onedrive/callback";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("同一セッションの同時リフレッシュを1回に集約する", async () => {
    const sessionId = `session-${crypto.randomUUID()}`;
    storeTokenForSession(sessionId, {
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

    const token3 = await getAccessToken(request);
    expect(token3).toBe("new-access-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

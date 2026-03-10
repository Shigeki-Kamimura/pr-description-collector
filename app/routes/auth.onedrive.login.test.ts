import { describe, expect, it, vi } from "vitest";
import { loader } from "./auth.onedrive.login";

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

describe("auth.onedrive.login loader", () => {
  it("HTTPアクセスは400で拒否する", async () => {
    const request = new Request("http://localhost:5173/auth/onedrive/login");

    const response = await loader({ request });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("Secure Cookie is unavailable on HTTP");
  });

  it("Redis障害時は503で停止する", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { ensureOAuthSessionStoreAvailable } = await import("../services/onedrive-oauth-session.server");
    vi.mocked(ensureOAuthSessionStoreAvailable).mockRejectedValue(
      new (class OAuthSessionStoreUnavailableError extends Error {
        constructor() {
          super("redis down token=super-secret-token");
          this.name = "OAuthSessionStoreUnavailableError";
        }
      })(),
    );

    const request = new Request("https://localhost:5173/auth/onedrive/login");
    const response = await loader({ request });
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(body).toContain("OneDrive 認証基盤で一時障害");
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      "OneDrive OAuth session store failed.",
      expect.objectContaining({
        message: expect.not.stringContaining("super-secret-token"),
      }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      "OneDrive OAuth session store failed.",
      expect.objectContaining({
        message: expect.stringContaining("[REDACTED]"),
      }),
    );
    errorSpy.mockRestore();
  });
});

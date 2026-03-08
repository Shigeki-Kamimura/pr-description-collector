import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader } from "./api.onedrive.session-status";
import { getAccessToken, OneDriveOAuthTokenMissingError } from "../services/onedrive-auth.server";
import { createOneDriveService } from "../services/onedrive.server";
import { OAuthSessionStoreUnavailableError } from "../services/onedrive-oauth-session.server";

vi.mock("../services/onedrive-auth.server", () => ({
  OneDriveOAuthTokenMissingError: class OneDriveOAuthTokenMissingError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "OneDriveOAuthTokenMissingError";
    }
  },
  getAccessToken: vi.fn(),
  isOneDriveOAuthTokenMissingError: (error: unknown) =>
    error instanceof Error && error.name === "OneDriveOAuthTokenMissingError",
}));

vi.mock("../services/onedrive.server", () => ({
  createOneDriveService: vi.fn(),
}));

vi.mock("../services/onedrive-oauth-session.server", () => ({
  OAuthSessionStoreUnavailableError: class OAuthSessionStoreUnavailableError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "OAuthSessionStoreUnavailableError";
    }
  },
  isOAuthSessionStoreUnavailableError: (error: unknown) =>
    error instanceof Error && error.name === "OAuthSessionStoreUnavailableError",
}));

function buildRequest(): Request {
  return new Request("http://localhost/api/onedrive/session-status");
}

describe("api.onedrive.session-status loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("OneDrive非認証エラーは内部詳細を露出せず定型メッセージを返す", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getAccessToken).mockResolvedValue("token");
    vi.mocked(createOneDriveService).mockReturnValue({
      getDriveInfo: vi.fn().mockRejectedValue(
        new Error("OneDrive API error (500) [code=generalException]: sensitive-internal-detail"),
      ),
    } as never);

    const response = await loader({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      isAuthError: boolean;
      error: string;
      errorCode?: string;
      errorMessage?: string;
    };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toBe("OneDrive セッション確認に失敗しました。しばらくしてから再実行してください。");
    expect(body.errorCode).toBeUndefined();
    expect(body.errorMessage).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("Redis障害は503で一時障害として返す", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getAccessToken).mockRejectedValue(new OAuthSessionStoreUnavailableError("redis down"));

    const response = await loader({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      isAuthError: boolean;
      error: string;
    };

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toContain("OneDrive 認証基盤で一時障害");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("token欠落は認証エラーとして401を返す", async () => {
    vi.mocked(getAccessToken).mockRejectedValue(new OneDriveOAuthTokenMissingError("token missing"));

    const response = await loader({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      isAuthError: boolean;
      error: string;
    };

    expect(response.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(true);
  });

  it("認証エラー詳細はレスポンスへ露出しない", async () => {
    vi.mocked(getAccessToken).mockRejectedValue(
      new Error("OneDrive API error (401) [code=InvalidAuthenticationToken]: token=super-secret-token"),
    );

    const response = await loader({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      isAuthError: boolean;
      error: string;
      errorCode?: string;
      errorMessage?: string;
    };

    expect(response.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(true);
    expect(body.errorCode).toBe("InvalidAuthenticationToken");
    expect(body.errorMessage).toBeUndefined();
    expect(body.error).toBe("OneDrive 認証が有効ではありません。Connect OneDrive から再認証してください。");
  });

  it("token crypto 障害は認証エラー扱いせず502を返す", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getAccessToken).mockRejectedValue(new Error("OneDrive token crypto encrypt failed: cipher failed"));

    const response = await loader({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      isAuthError: boolean;
      error: string;
    };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

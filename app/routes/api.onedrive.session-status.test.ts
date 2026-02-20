import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader } from "./api.onedrive.session-status";
import { getAccessToken } from "../services/onedrive-auth.server";
import { createOneDriveService } from "../services/onedrive.server";

vi.mock("../services/onedrive-auth.server", () => ({
  getAccessToken: vi.fn(),
}));

vi.mock("../services/onedrive.server", () => ({
  createOneDriveService: vi.fn(),
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
});

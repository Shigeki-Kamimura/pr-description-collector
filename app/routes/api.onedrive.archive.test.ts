/**
 * /api/onedrive/archive ルートのテスト
 *
 * このファイルを用意した理由:
 * - archive.json 取得の契約（found判定、evidenceImages整形）を固定し、表示回帰を防ぐため。
 *
 * このファイルが使われる場面:
 * - `npm run test` 実行時に、保存済み画像優先表示の前提データ取得が正しいか確認するとき。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "./api.onedrive.archive";
import { createGitHubServiceFromEnv } from "../services/github.server";
import { createOneDriveServiceFromEnv } from "../services/onedrive.server";
import { validatePrRefInput } from "../services/validation";
import { verifyCsrfToken } from "../services/csrf.server";

vi.mock("../services/github.server", () => ({
  createGitHubServiceFromEnv: vi.fn(),
}));

vi.mock("../services/onedrive.server", () => ({
  createOneDriveServiceFromEnv: vi.fn(),
}));

vi.mock("../services/validation", () => ({
  validatePrRefInput: vi.fn(),
}));

vi.mock("../services/csrf.server", () => ({
  verifyCsrfToken: vi.fn(),
}));

type MockGitHubService = {
  getPullRequest: ReturnType<typeof vi.fn>;
};

type MockOneDriveService = {
  getDriveInfo: ReturnType<typeof vi.fn>;
  getItem: ReturnType<typeof vi.fn>;
  getText: ReturnType<typeof vi.fn>;
};

function buildRequest(): Request {
  const form = new FormData();
  form.set("owner", "octocat");
  form.set("repo", "hello-world");
  form.set("prNumber", "123");
  form.set("csrfToken", "csrf-token");
  return new Request("http://localhost/api/onedrive/archive", { method: "POST", body: form });
}

describe("api.onedrive.archive action", () => {
  let github: MockGitHubService;
  let onedrive: MockOneDriveService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validatePrRefInput).mockReturnValue({
      ok: true,
      owner: "octocat",
      repo: "hello-world",
      prNumber: 123,
    });
    vi.mocked(verifyCsrfToken).mockResolvedValue(true);
    github = {
      getPullRequest: vi.fn().mockResolvedValue({
        number: 123,
        title: "Test PR",
        url: "https://github.com/octocat/hello-world/pull/123",
        body: "",
      }),
    };
    vi.mocked(createGitHubServiceFromEnv).mockResolvedValue(github as never);

    onedrive = {
      getDriveInfo: vi.fn().mockResolvedValue({ id: "drive-1", driveType: "business" }),
      getItem: vi.fn(),
      getText: vi.fn(),
    };
    vi.mocked(createOneDriveServiceFromEnv).mockResolvedValue(onedrive as never);
  });

  it("archive.json が無い場合は found=false を返す", async () => {
    onedrive.getItem.mockResolvedValueOnce(null);

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: true; found: boolean; evidenceImages: unknown[] };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.found).toBe(false);
    expect(body.evidenceImages).toEqual([]);
  });

  it("archive.json から保存済み画像情報を返す", async () => {
    onedrive.getItem.mockImplementation(async (path: string) => {
      if (path.endsWith("/archive.json")) {
        return { name: "archive.json", webUrl: "https://example.com/archive" };
      }
      if (path.endsWith("/imgs/a.png")) {
        return { name: "a.png", webUrl: "https://example.com/imgs/a.png" };
      }
      return null;
    });
    onedrive.getText.mockResolvedValue(
      JSON.stringify({
        evidenceImages: [
          {
            sourceUrl: "https://example.com/a.png?b=2&a=1",
            status: "success",
            fileName: "a.png",
            onedrivePath: "project/hello-world/PullRequests/PR123-Test-PR/imgs/a.png",
          },
        ],
      }),
    );

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: true;
      found: boolean;
      evidenceImages: Array<{
        sourceUrl: string;
        normalizedSourceUrl: string;
        webUrl: string | null;
        status: string;
        imageAccessToken: string | null;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.found).toBe(true);
    expect(body.evidenceImages).toHaveLength(1);
    expect(body.evidenceImages[0]).toMatchObject({
      sourceUrl: "https://example.com/a.png?b=2&a=1",
      normalizedSourceUrl: "https://example.com/a.png?a=1&b=2",
      webUrl: "https://example.com/imgs/a.png",
      status: "success",
    });
    expect(body.evidenceImages[0].imageAccessToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it("OneDrive認証エラー時は内部詳細を露出せず定型メッセージを返す", async () => {
    onedrive.getDriveInfo.mockRejectedValue(
      new Error("OneDrive API error (401) [code=InvalidAuthenticationToken]: token expired"),
    );

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      error: string;
      isAuthError: boolean;
      errorCode?: string;
      errorMessage?: string;
    };

    expect(response.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(true);
    expect(body.error).toBe("OneDrive 認証が切れています。再認証してから再実行してください。");
    expect(body.errorCode).toBeUndefined();
    expect(body.errorMessage).toBeUndefined();
  });
});

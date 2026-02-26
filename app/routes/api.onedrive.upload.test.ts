/**
 * OneDriveアップロードAPIルートのテスト
 *
 * このファイルを用意した理由:
 * - 保存処理の失敗分岐（部分書き込み時のロールバック）と認証エラー判定を固定し、
 *   本番運用での回帰を防ぐため。
 *
 * このファイルが使われる場面:
 * - `npm run test` 実行時に、`/api/onedrive/upload` のエラーハンドリング契約を検証するとき。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "./api.onedrive.upload";
import { createGitHubServiceFromEnv } from "../services/github.server";
import { createOneDriveServiceFromEnv, OneDriveApiError } from "../services/onedrive.server";
import { parseChecklist } from "../services/checklist";
import { verifyCsrfToken } from "../services/csrf.server";
import { validatePrRefInput } from "../services/validation";
// 画像保存ユーティリティ
import {
  buildImageBaseName,
  downloadImageWithRetry,
  extractUniqueImageUrls,
} from "../services/evidence-images.server";

vi.mock("../services/github.server", () => ({
  createGitHubServiceFromEnv: vi.fn(),
}));

vi.mock("../services/onedrive.server", () => ({
  createOneDriveServiceFromEnv: vi.fn(),
  OneDriveApiError: class OneDriveApiError extends Error {
    status: number; // HTTPステータスコード
    code?: string; // APIエラーコード（存在する場合）
    constructor(message: string, status: number, code?: string) {
      super(message); // Errorのmessageプロパティに設定
      this.name = "OneDriveApiError";
      this.status = status;
      this.code = code;
    }
  },
}));

vi.mock("../services/checklist", () => ({
  parseChecklist: vi.fn(),
}));

vi.mock("../services/csrf.server", () => ({
  verifyCsrfToken: vi.fn(),
}));

vi.mock("../services/validation", () => ({
  validatePrRefInput: vi.fn(),
}));

vi.mock("../services/evidence-images.server", () => ({
  extractUniqueImageUrls: vi.fn(),
  downloadImageWithRetry: vi.fn(),
  buildImageBaseName: vi.fn(),
}));

type MockGitHubService = {
  getPullRequest: ReturnType<typeof vi.fn>;
  getPullRequestReviews: ReturnType<typeof vi.fn>;
};

type MockOneDriveService = {
  getDriveInfo: ReturnType<typeof vi.fn>;
  getCurrentUser: ReturnType<typeof vi.fn>;
  saveText: ReturnType<typeof vi.fn>;
  saveBinary: ReturnType<typeof vi.fn>;
  getItem: ReturnType<typeof vi.fn>;
  getText: ReturnType<typeof vi.fn>;
  deleteItem: ReturnType<typeof vi.fn>;
};

function buildRequest(): Request {
  const form = new FormData();
  form.set("owner", "octocat");
  form.set("repo", "hello-world");
  form.set("prNumber", "123");
  return new Request("http://localhost/api/onedrive/upload", { method: "POST", body: form });
}

describe("api.onedrive.upload action", () => {
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
    vi.mocked(parseChecklist).mockReturnValue({ items: [], checked: 0, total: 0 });
    vi.mocked(extractUniqueImageUrls).mockReturnValue([]);
    vi.mocked(buildImageBaseName).mockReturnValue("image.png");
    vi.mocked(downloadImageWithRetry).mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    });

    github = {
      getPullRequest: vi.fn().mockResolvedValue({
        number: 123,
        title: "Test PR",
        url: "https://github.com/octocat/hello-world/pull/123",
        body: "- [x] done",
        authorLogin: "author",
        mergedByLogin: "merger",
      }),
      getPullRequestReviews: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(createGitHubServiceFromEnv).mockResolvedValue(github as never);

    onedrive = {
      getDriveInfo: vi.fn().mockResolvedValue({ id: "drive-1", driveType: "business" }),
      getCurrentUser: vi.fn().mockResolvedValue({
        id: "user-1",
        displayName: "Display Name",
        userPrincipalName: "user@example.com",
      }),
      saveText: vi.fn(),
      saveBinary: vi.fn().mockResolvedValue({ name: "image.png", webUrl: "https://example.com/image.png" }),
      getItem: vi.fn().mockResolvedValue(null),
      getText: vi.fn(),
      deleteItem: vi.fn(),
    };
    vi.mocked(createOneDriveServiceFromEnv).mockResolvedValue(onedrive as never);
  });

  it("CSRF トークン不一致時は 403 で拒否する", async () => {
    vi.mocked(verifyCsrfToken).mockResolvedValue(false);

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; error: string; isAuthError: boolean };

    expect(response.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toContain("不正なリクエスト");
    expect(createGitHubServiceFromEnv).not.toHaveBeenCalled();
    expect(createOneDriveServiceFromEnv).not.toHaveBeenCalled();
  });

  it("archive保存失敗後にロールバック成功時も内部詳細を露出せず定型メッセージを返す", async () => {
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockRejectedValueOnce(new Error("archive write failed"));
    onedrive.deleteItem.mockResolvedValue(undefined);

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; error: string };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("OneDrive への保存に失敗しました。しばらくしてから再実行してください。");
    expect(onedrive.deleteItem).toHaveBeenCalledTimes(2);
  });

  it("archive保存失敗後にロールバック失敗時も内部詳細を露出せず定型メッセージを返す", async () => {
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockRejectedValueOnce(new Error("archive write failed"));
    onedrive.deleteItem.mockRejectedValue(new Error("delete failed"));

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; error: string };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("OneDrive への保存に失敗しました。しばらくしてから再実行してください。");
  });

  it("archive保存失敗後のフォルダ削除失敗は警告ログのみで処理継続する", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockRejectedValueOnce(new Error("archive write failed"));
    onedrive.deleteItem
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("folder not empty"));

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; error: string };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("OneDrive への保存に失敗しました。しばらくしてから再実行してください。");
    expect(onedrive.deleteItem).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("archive保存失敗後に画像ロールバックが一部失敗した場合は partial を記録する", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: "![a](https://example.com/a.png)\n![b](https://example.com/b.png)",
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue([
      "https://example.com/a.png",
      "https://example.com/b.png",
    ]);
    vi.mocked(downloadImageWithRetry)
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), contentType: "image/png" })
      .mockResolvedValueOnce({ bytes: new Uint8Array([2]), contentType: "image/png" });
    onedrive.saveBinary
      .mockResolvedValueOnce({ name: "image-a.png", webUrl: "https://example.com/a" })
      .mockResolvedValueOnce({ name: "image-b.png", webUrl: "https://example.com/b" });
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockRejectedValueOnce(new Error("archive write failed"));
    onedrive.deleteItem
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; error: string };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("OneDrive への保存に失敗しました。しばらくしてから再実行してください。");
    expect(errorSpy).toHaveBeenCalledWith(
      "OneDrive upload failed.",
      expect.objectContaining({
        message: expect.stringContaining("rollback=failed (evidence-cleanup-incomplete)"),
      }),
    );
    const deletedPaths = onedrive.deleteItem.mock.calls.map((args) => args[0] as string);
    expect(deletedPaths).not.toEqual(
      expect.arrayContaining([expect.stringContaining("/PullRequests/PR123-Test-PR/description.md")]),
    );
    errorSpy.mockRestore();
  });

  it("OneDrive認証エラーを 401 / isAuthError=true で返す", async () => {
    onedrive.getDriveInfo.mockRejectedValue(
      new Error("OneDrive API error (401) [code=InvalidAuthenticationToken]: token expired"),
    );

    const response = await action({ request: buildRequest() } as never);
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
    expect(body.error).toBe("OneDrive 認証が切れています。再認証してから保存をやり直してください。");
    expect(body.errorCode).toBeUndefined();
    expect(body.errorMessage).toBeUndefined();
  });

  it("OneDrive非認証エラーは内部詳細を露出せず定型メッセージで返す", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    onedrive.getDriveInfo.mockRejectedValue(
      new Error("OneDrive API error (500) [code=generalException]: sensitive-internal-detail"),
    );

    const response = await action({ request: buildRequest() } as never);
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
    expect(body.error).toBe("OneDrive への保存に失敗しました。しばらくしてから再実行してください。");
    expect(body.errorCode).toBeUndefined();
    expect(body.errorMessage).toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("parseChecklist 例外は OneDrive 認証エラーに誤分類しない", async () => {
    vi.mocked(parseChecklist).mockImplementationOnce(() => {
      throw new Error("checklist parse failed");
    });

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; isAuthError: boolean; error: string };

    expect(response.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toBe("保存処理中に予期しないエラーが発生しました。しばらくしてから再実行してください。");
    expect(onedrive.saveText).not.toHaveBeenCalled();
  });

  it("成功時に folderPath と uploaded 情報を返す", async () => {
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: true;
      folderPath: string;
      evidenceImages: {
        total: number;
        success: number;
        failed: number;
        alreadySaved: number;
      };
      alreadySavedFiles: {
        descriptionMd: boolean;
        archiveJson: boolean;
      };
      evidenceImageRecords: Array<{
        sourceUrl: string;
        status: string;
        webUrl: string | null;
      }>;
      uploaded: {
        descriptionMd: { name: string; webUrl: string };
        archiveJson: { name: string; webUrl: string };
      };
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.folderPath).toContain("project/hello-world/PullRequests/PR123-Test-PR");
    expect(body.uploaded.descriptionMd).toEqual({
      name: "description.md",
      webUrl: "https://example.com/desc",
    });
    expect(body.uploaded.archiveJson).toEqual({
      name: "archive.json",
      webUrl: "https://example.com/archive",
    });
    expect(body.evidenceImages).toEqual({
      total: 0,
      success: 0,
      failed: 0,
      alreadySaved: 0,
    });
    expect(body.alreadySavedFiles).toEqual({
      descriptionMd: false,
      archiveJson: false,
    });
    expect(body.evidenceImageRecords).toEqual([]);
    expect(onedrive.saveText).toHaveBeenCalledTimes(2);
  });

  it("既存archiveに同一sourceUrlがある場合は画像を再保存せず alreadySaved を返す", async () => {
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: "![a](https://example.com/a.png)",
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue(["https://example.com/a.png"]);
    onedrive.getItem.mockImplementation(async (path: string) => {
      if (path.endsWith("/archive.json")) {
        return { name: "archive.json", webUrl: "https://example.com/archive" };
      }
      if (path.endsWith("/imgs/a.png")) {
        return { name: "a.png", webUrl: "https://example.com/a-from-onedrive.png" };
      }
      return null;
    });
    onedrive.getText.mockResolvedValue(
      JSON.stringify({
        evidenceImages: [
          {
            sourceUrl: "https://example.com/a.png",
            status: "success",
            fileName: "a.png",
            onedrivePath: "project/hello-world/PullRequests/PR123-Test-PR/imgs/a.png",
          },
        ],
      }),
    );
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive-new" });

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: true;
      evidenceImages: { total: number; success: number; failed: number; alreadySaved: number };
      alreadySavedFiles: { descriptionMd: boolean; archiveJson: boolean };
      evidenceImageRecords: Array<{
        sourceUrl: string;
        status: string;
        webUrl: string | null;
        imageAccessToken: string | null;
      }>;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(onedrive.saveBinary).not.toHaveBeenCalled();
    expect(body.evidenceImages).toEqual({
      total: 1,
      success: 1,
      failed: 0,
      alreadySaved: 1,
    });
    expect(body.alreadySavedFiles).toEqual({
      descriptionMd: false,
      archiveJson: true,
    });
    expect(body.evidenceImageRecords).toHaveLength(1);
    expect(body.evidenceImageRecords[0]).toMatchObject({
      sourceUrl: "https://example.com/a.png",
      status: "success",
      webUrl: "https://example.com/a-from-onedrive.png",
    });
    expect(body.evidenceImageRecords[0].imageAccessToken).toMatch(/^[0-9a-f]{64}:[0-9]{10,16}$/);
  });

  it("既存archive読取でOneDrive認証エラーが発生した場合は保存を中止して401を返す", async () => {
    onedrive.getItem.mockImplementation(async (path: string) => {
      if (path.endsWith("/archive.json")) {
        return { name: "archive.json", webUrl: "https://example.com/archive" };
      }
      return null;
    });
    onedrive.getText.mockRejectedValue(
      new OneDriveApiError(
        "OneDrive API error (401) [code=InvalidAuthenticationToken]: token expired",
        401,
        "InvalidAuthenticationToken",
      ),
    );

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; isAuthError: boolean; error: string };

    expect(response.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(true);
    expect(body.error).toBe("OneDrive 認証が切れています。再認証してから保存をやり直してください。");
    expect(onedrive.saveBinary).not.toHaveBeenCalled();
    expect(onedrive.saveText).not.toHaveBeenCalled();
  });

  it("既存archive読取でJSONパース失敗した場合は保存を中止して502を返す", async () => {
    onedrive.getItem.mockImplementation(async (path: string) => {
      if (path.endsWith("/archive.json")) {
        return { name: "archive.json", webUrl: "https://example.com/archive" };
      }
      return null;
    });
    onedrive.getText.mockResolvedValue("{invalid-json");

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; isAuthError: boolean; error: string };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toBe("OneDrive への保存に失敗しました。しばらくしてから再実行してください。");
    expect(onedrive.saveBinary).not.toHaveBeenCalled();
    expect(onedrive.saveText).not.toHaveBeenCalled();
  });

  it("既存archiveに同一sourceUrlがあっても実体画像が無ければ再保存する", async () => {
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: "![a](https://example.com/a.png)",
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue(["https://example.com/a.png"]);
    onedrive.getItem.mockImplementation(async (path: string) => {
      if (path.endsWith("/archive.json")) {
        return { name: "archive.json", webUrl: "https://example.com/archive" };
      }
      if (path.endsWith("/imgs/a.png")) {
        return null;
      }
      return null;
    });
    onedrive.getText.mockResolvedValue(
      JSON.stringify({
        evidenceImages: [
          {
            sourceUrl: "https://example.com/a.png",
            status: "success",
            fileName: "a.png",
            onedrivePath: "project/hello-world/PullRequests/PR123-Test-PR/imgs/a.png",
          },
        ],
      }),
    );
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive-new" });

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: true;
      evidenceImages: { total: number; success: number; failed: number; alreadySaved: number };
      evidenceImageRecords: Array<{ sourceUrl: string; status: string; errorReason: string | null }>;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(onedrive.saveBinary).toHaveBeenCalledTimes(1);
    expect(body.evidenceImages).toEqual({
      total: 1,
      success: 1,
      failed: 0,
      alreadySaved: 0,
    });
    expect(body.evidenceImageRecords[0]).toMatchObject({
      sourceUrl: "https://example.com/a.png",
      status: "success",
      errorReason: null,
    });
  });

  it("画像URLが重複しても1回だけ保存し evidenceImages に1件記録する", async () => {
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: "![a](https://example.com/a.png)\n![dup](https://example.com/a.png)",
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue(["https://example.com/a.png"]);
    vi.mocked(buildImageBaseName).mockReturnValue("a.png");
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });

    const response = await action({ request: buildRequest() } as never);
    expect(response.status).toBe(200);
    expect(onedrive.saveBinary).toHaveBeenCalledTimes(1);
    const archiveBody = JSON.parse(onedrive.saveText.mock.calls[1][1] as string) as {
      evidenceImages: Array<{ sourceUrl: string; status: string }>;
    };
    expect(archiveBody.evidenceImages).toHaveLength(1);
    expect(archiveBody.evidenceImages[0]).toMatchObject({
      sourceUrl: "https://example.com/a.png",
      status: "success",
    });
  });

  it("画像保存で失敗が混在しても処理継続し failed を記録する", async () => {
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: "![a](https://example.com/a.png)\n![b](https://example.com/b.png)",
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue([
      "https://example.com/a.png",
      "https://example.com/b.png",
    ]);
    vi.mocked(downloadImageWithRetry)
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), contentType: "image/png" })
      .mockResolvedValueOnce({ ok: false, errorReason: "HTTP_404" });
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });

    const response = await action({ request: buildRequest() } as never);
    expect(response.status).toBe(200);
    const archiveBody = JSON.parse(onedrive.saveText.mock.calls[1][1] as string) as {
      evidenceImages: Array<{ sourceUrl: string; status: string; errorReason: string | null }>;
    };
    expect(archiveBody.evidenceImages).toHaveLength(2);
    expect(archiveBody.evidenceImages[0]).toMatchObject({
      sourceUrl: "https://example.com/a.png",
      status: "success",
      errorReason: null,
    });
    expect(archiveBody.evidenceImages[1]).toMatchObject({
      sourceUrl: "https://example.com/b.png",
      status: "failed",
      errorReason: "HTTP_404",
    });
  });

  it("同名画像が既存でも getItem 連打せずローカル採番で保存する", async () => {
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: "![a](https://example.com/a.png)\n![b](https://example.com/b.png)",
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue([
      "https://example.com/a.png",
      "https://example.com/b.png",
    ]);
    vi.mocked(buildImageBaseName).mockReturnValue("image.png");
    vi.mocked(downloadImageWithRetry)
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), contentType: "image/png" })
      .mockResolvedValueOnce({ bytes: new Uint8Array([2]), contentType: "image/png" });
    onedrive.getItem.mockImplementation(async (path: string) => {
      if (path.endsWith("/archive.json")) return null;
      if (path.endsWith("/imgs/image.png")) {
        return { name: "image.png", webUrl: "https://example.com/existing-image" };
      }
      return null;
    });
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });

    const response = await action({ request: buildRequest() } as never);

    expect(response.status).toBe(200);
    expect(onedrive.getItem).toHaveBeenCalledTimes(3);
    expect(onedrive.getItem).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("/imgs/image.png"),
    );
    expect(onedrive.saveBinary).toHaveBeenCalledTimes(2);
    expect(onedrive.saveBinary).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/imgs/image-1.png"),
      expect.any(Uint8Array),
      "image/png",
    );
    expect(onedrive.saveBinary).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/imgs/image-2.png"),
      expect.any(Uint8Array),
      "image/png",
    );
  });

  it("saveBinary で 412 競合が起きた場合は再採番して再試行する", async () => {
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: "![a](https://example.com/a.png)",
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue(["https://example.com/a.png"]);
    vi.mocked(buildImageBaseName).mockReturnValue("image.png");
    vi.mocked(downloadImageWithRetry).mockResolvedValueOnce({ bytes: new Uint8Array([1]), contentType: "image/png" });
    onedrive.getItem.mockImplementation(async (path: string) => {
      if (path.endsWith("/archive.json")) return null;
      if (path.endsWith("/imgs/image.png")) {
        return { name: "image.png", webUrl: "https://example.com/existing-image" };
      }
      return null;
    });
    onedrive.saveBinary
      .mockRejectedValueOnce(new OneDriveApiError("name conflict", 412, "nameAlreadyExists"))
      .mockResolvedValueOnce({ name: "image-2.png", webUrl: "https://example.com/image-2.png" });
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });

    const response = await action({ request: buildRequest() } as never);
    expect(response.status).toBe(200);
    expect(onedrive.getItem).toHaveBeenCalledTimes(3);
    expect(onedrive.saveBinary).toHaveBeenCalledTimes(2);
    expect(onedrive.saveBinary).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/imgs/image-1.png"),
      expect.any(Uint8Array),
      "image/png",
    );
    expect(onedrive.saveBinary).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("/imgs/image-2.png"),
      expect.any(Uint8Array),
      "image/png",
    );
  });

  it("画像保存中のOneDrive認証切れは中断して401を返す", async () => {
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: "![a](https://example.com/a.png)",
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue(["https://example.com/a.png"]);
    onedrive.saveBinary.mockRejectedValueOnce(
      new Error("OneDrive API error (401) [code=InvalidAuthenticationToken]: token expired"),
    );
    onedrive.saveText.mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" });

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; isAuthError: boolean };
    expect(response.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(true);
    expect(onedrive.saveText).toHaveBeenCalledTimes(1);
  });

  it("画像保存途中の認証切れでは保存済み画像をロールバック削除する", async () => {
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: "![a](https://example.com/a.png)\n![b](https://example.com/b.png)",
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue([
      "https://example.com/a.png",
      "https://example.com/b.png",
    ]);
    vi.mocked(buildImageBaseName).mockReturnValue("image.png");
    vi.mocked(downloadImageWithRetry)
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), contentType: "image/png" })
      .mockResolvedValueOnce({ bytes: new Uint8Array([2]), contentType: "image/png" });
    onedrive.saveText.mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" });
    onedrive.saveBinary
      .mockResolvedValueOnce({ name: "image.png", webUrl: "https://example.com/image.png" })
      .mockRejectedValueOnce(
        new Error("OneDrive API error (401) [code=InvalidAuthenticationToken]: token expired"),
      );

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; isAuthError: boolean };

    expect(response.status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(true);
    const deletedPaths = onedrive.deleteItem.mock.calls.map((args) => args[0] as string);
    expect(deletedPaths).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/PullRequests/PR123-Test-PR/imgs/image.png"),
        expect.stringContaining("/PullRequests/PR123-Test-PR/description.md"),
      ]),
    );
  });

  it("非画像Content-Typeは保存せず failed として記録する", async () => {
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: "![a](https://example.com/a.png)",
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue(["https://example.com/a.png"]);
    vi.mocked(downloadImageWithRetry).mockResolvedValueOnce({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "text/html",
    });
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });

    const response = await action({ request: buildRequest() } as never);
    expect(response.status).toBe(200);
    expect(onedrive.saveBinary).not.toHaveBeenCalled();
    const archiveBody = JSON.parse(onedrive.saveText.mock.calls[1][1] as string) as {
      evidenceImages: Array<{ status: string; errorReason: string | null }>;
    };
    expect(archiveBody.evidenceImages).toHaveLength(1);
    expect(archiveBody.evidenceImages[0]).toMatchObject({
      status: "failed",
      errorReason: "UNSUPPORTED_CONTENT_TYPE: text/html",
    });
  });

  it("SVGは保存せず failed として記録する", async () => {
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: "![a](https://example.com/a.svg)",
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue(["https://example.com/a.svg"]);
    vi.mocked(downloadImageWithRetry).mockResolvedValueOnce({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/svg+xml",
    });
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });

    const response = await action({ request: buildRequest() } as never);
    expect(response.status).toBe(200);
    expect(onedrive.saveBinary).not.toHaveBeenCalled();
    const archiveBody = JSON.parse(onedrive.saveText.mock.calls[1][1] as string) as {
      evidenceImages: Array<{ status: string; errorReason: string | null }>;
    };
    expect(archiveBody.evidenceImages).toHaveLength(1);
    expect(archiveBody.evidenceImages[0]).toMatchObject({
      status: "failed",
      errorReason: "UNSUPPORTED_CONTENT_TYPE: image/svg+xml",
    });
  });

  it("画像件数が上限を超える場合は超過分をスキップして failed 記録する", async () => {
    const previousLimit = process.env.ONEDRIVE_EVIDENCE_IMAGE_MAX_COUNT;
    process.env.ONEDRIVE_EVIDENCE_IMAGE_MAX_COUNT = "2";
    try {
      const urls = [
        "https://example.com/a.png",
        "https://example.com/b.png",
        "https://example.com/c.png",
        "https://example.com/d.png",
      ];
      github.getPullRequest.mockResolvedValueOnce({
        number: 123,
        title: "Test PR",
        url: "https://github.com/octocat/hello-world/pull/123",
        body: urls.map((url, i) => `![${i}](${url})`).join("\n"),
        authorLogin: "author",
        mergedByLogin: "merger",
      });
      vi.mocked(extractUniqueImageUrls).mockReturnValue(urls);
      vi.mocked(buildImageBaseName).mockReturnValue("image.png");
      vi.mocked(downloadImageWithRetry)
        .mockResolvedValueOnce({ bytes: new Uint8Array([1]), contentType: "image/png" })
        .mockResolvedValueOnce({ bytes: new Uint8Array([2]), contentType: "image/png" });
      onedrive.saveText
        .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
        .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });

      const response = await action({ request: buildRequest() } as never);
      expect(response.status).toBe(200);
      expect(downloadImageWithRetry).toHaveBeenCalledTimes(2);
      expect(onedrive.saveBinary).toHaveBeenCalledTimes(2);
      const archiveBody = JSON.parse(onedrive.saveText.mock.calls[1][1] as string) as {
        evidenceImages: Array<{ sourceUrl: string; status: string; errorReason: string | null }>;
      };
      expect(archiveBody.evidenceImages).toHaveLength(3);
      expect(archiveBody.evidenceImages[2]).toMatchObject({
        sourceUrl: "https://example.com/c.png",
        status: "failed",
        errorReason: "IMAGE_LIMIT_EXCEEDED_REMAINING:2",
      });
    } finally {
      if (previousLimit === undefined) {
        delete process.env.ONEDRIVE_EVIDENCE_IMAGE_MAX_COUNT;
      } else {
        process.env.ONEDRIVE_EVIDENCE_IMAGE_MAX_COUNT = previousLimit;
      }
    }
  });

  it("画像サイズ上限が単純アップロード上限を超える場合は250MBにクランプする", async () => {
    const previousMaxKb = process.env.ONEDRIVE_EVIDENCE_IMAGE_MAX_KB;
    process.env.ONEDRIVE_EVIDENCE_IMAGE_MAX_KB = "999999";
    try {
      github.getPullRequest.mockResolvedValueOnce({
        number: 123,
        title: "Test PR",
        url: "https://github.com/octocat/hello-world/pull/123",
        body: "![a](https://example.com/a.png)",
        authorLogin: "author",
        mergedByLogin: "merger",
      });
      vi.mocked(extractUniqueImageUrls).mockReturnValue(["https://example.com/a.png"]);
      vi.mocked(downloadImageWithRetry).mockResolvedValueOnce({
        bytes: new Uint8Array([1]),
        contentType: "image/png",
      });
      onedrive.saveText
        .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
        .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });

      const response = await action({ request: buildRequest() } as never);
      expect(response.status).toBe(200);
      expect(downloadImageWithRetry).toHaveBeenCalledWith(
        "https://example.com/a.png",
        expect.objectContaining({ maxBytes: 250 * 1024 * 1024 }),
      );
    } finally {
      if (previousMaxKb === undefined) {
        delete process.env.ONEDRIVE_EVIDENCE_IMAGE_MAX_KB;
      } else {
        process.env.ONEDRIVE_EVIDENCE_IMAGE_MAX_KB = previousMaxKb;
      }
    }
  });

  it("非認証のOneDriveエラーが2件連続したら残り画像をスキップする", async () => {
    const urls = [
      "https://example.com/a.png",
      "https://example.com/b.png",
      "https://example.com/c.png",
      "https://example.com/d.png",
    ];
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: urls.map((url, i) => `![${i}](${url})`).join("\n"),
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue(urls);
    vi.mocked(buildImageBaseName).mockReturnValue("image.png");
    vi.mocked(downloadImageWithRetry)
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), contentType: "image/png" })
      .mockResolvedValueOnce({ bytes: new Uint8Array([2]), contentType: "image/png" });
    onedrive.saveBinary
      .mockRejectedValueOnce(new OneDriveApiError("storage quota exceeded", 507, "insufficientStorage"))
      .mockRejectedValueOnce(new OneDriveApiError("quota still exceeded", 507, "insufficientStorage"));
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });

    const response = await action({ request: buildRequest() } as never);
    expect(response.status).toBe(200);
    expect(downloadImageWithRetry).toHaveBeenCalledTimes(2);
    expect(onedrive.saveBinary).toHaveBeenCalledTimes(2);
    const archiveBody = JSON.parse(onedrive.saveText.mock.calls[1][1] as string) as {
      evidenceImages: Array<{ sourceUrl: string; status: string; errorReason: string | null }>;
    };
    expect(archiveBody.evidenceImages).toHaveLength(4);
    expect(archiveBody.evidenceImages[0]).toMatchObject({
      sourceUrl: "https://example.com/a.png",
      status: "failed",
      errorReason: "ONEDRIVE_SAVE_FAILED",
    });
    expect(archiveBody.evidenceImages[1]).toMatchObject({
      sourceUrl: "https://example.com/b.png",
      status: "failed",
      errorReason: "ONEDRIVE_SAVE_FAILED",
    });
    expect(archiveBody.evidenceImages[2]).toMatchObject({
      sourceUrl: "https://example.com/c.png",
      status: "failed",
      errorReason: "ONEDRIVE_SAVE_SKIPPED_AFTER_CONSECUTIVE_FAILURE",
    });
    expect(archiveBody.evidenceImages[3]).toMatchObject({
      sourceUrl: "https://example.com/d.png",
      status: "failed",
      errorReason: "ONEDRIVE_SAVE_SKIPPED_AFTER_CONSECUTIVE_FAILURE",
    });
  });

  it("OneDrive APIエラーの間に非OneDriveエラーがあっても閾値到達後は残り画像をスキップする", async () => {
    const urls = [
      "https://example.com/a.png",
      "https://example.com/b.png",
      "https://example.com/c.png",
      "https://example.com/d.png",
    ];
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: urls.map((url, i) => `![${i}](${url})`).join("\n"),
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue(urls);
    vi.mocked(buildImageBaseName).mockReturnValue("image.png");
    vi.mocked(downloadImageWithRetry)
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), contentType: "image/png" })
      .mockResolvedValueOnce({ bytes: new Uint8Array([2]), contentType: "image/png" })
      .mockResolvedValueOnce({ bytes: new Uint8Array([3]), contentType: "image/png" });
    onedrive.saveBinary
      .mockRejectedValueOnce(new OneDriveApiError("quota exceeded", 507, "insufficientStorage"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(new OneDriveApiError("quota still exceeded", 507, "insufficientStorage"));
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });

    const response = await action({ request: buildRequest() } as never);
    expect(response.status).toBe(200);
    expect(downloadImageWithRetry).toHaveBeenCalledTimes(3);
    expect(onedrive.saveBinary).toHaveBeenCalledTimes(3);

    const archiveBody = JSON.parse(onedrive.saveText.mock.calls[1][1] as string) as {
      evidenceImages: Array<{ sourceUrl: string; status: string; errorReason: string | null }>;
    };
    expect(archiveBody.evidenceImages).toHaveLength(4);
    expect(archiveBody.evidenceImages[0]).toMatchObject({
      sourceUrl: "https://example.com/a.png",
      status: "failed",
      errorReason: "ONEDRIVE_SAVE_FAILED",
    });
    expect(archiveBody.evidenceImages[1]).toMatchObject({
      sourceUrl: "https://example.com/b.png",
      status: "failed",
      errorReason: "socket hang up",
    });
    expect(archiveBody.evidenceImages[2]).toMatchObject({
      sourceUrl: "https://example.com/c.png",
      status: "failed",
      errorReason: "ONEDRIVE_SAVE_FAILED",
    });
    expect(archiveBody.evidenceImages[3]).toMatchObject({
      sourceUrl: "https://example.com/d.png",
      status: "failed",
      errorReason: "ONEDRIVE_SAVE_SKIPPED_AFTER_CONSECUTIVE_FAILURE",
    });
  });

  it("OneDriveエラーの間にダウンロード失敗がある場合はカウンタをリセットする", async () => {
    const urls = [
      "https://example.com/a.png",
      "https://example.com/b.png",
      "https://example.com/c.png",
      "https://example.com/d.png",
    ];
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: urls.map((url, i) => `![${i}](${url})`).join("\n"),
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue(urls);
    vi.mocked(buildImageBaseName).mockReturnValue("image.png");
    vi.mocked(downloadImageWithRetry)
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), contentType: "image/png" })
      .mockResolvedValueOnce({ ok: false, errorReason: "TIMEOUT" })
      .mockResolvedValueOnce({ bytes: new Uint8Array([3]), contentType: "image/png" })
      .mockResolvedValueOnce({ bytes: new Uint8Array([4]), contentType: "image/png" });
    onedrive.saveBinary
      .mockRejectedValueOnce(new OneDriveApiError("quota exceeded", 507, "insufficientStorage"))
      .mockRejectedValueOnce(new OneDriveApiError("quota still exceeded", 507, "insufficientStorage"))
      .mockResolvedValueOnce({ name: "image.png", webUrl: "https://example.com/image.png" });
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });

    const response = await action({ request: buildRequest() } as never);
    expect(response.status).toBe(200);
    expect(downloadImageWithRetry).toHaveBeenCalledTimes(4);
    expect(onedrive.saveBinary).toHaveBeenCalledTimes(3);
    const archiveBody = JSON.parse(onedrive.saveText.mock.calls[1][1] as string) as {
      evidenceImages: Array<{ sourceUrl: string; status: string; errorReason: string | null }>;
    };
    expect(archiveBody.evidenceImages).toHaveLength(4);
    expect(archiveBody.evidenceImages[0]).toMatchObject({ status: "failed", errorReason: "ONEDRIVE_SAVE_FAILED" });
    expect(archiveBody.evidenceImages[1]).toMatchObject({ status: "failed", errorReason: "TIMEOUT" });
    expect(archiveBody.evidenceImages[2]).toMatchObject({ status: "failed", errorReason: "ONEDRIVE_SAVE_FAILED" });
    expect(archiveBody.evidenceImages[3]).toMatchObject({ status: "success" });
  });

  it("OneDriveエラーの間に非画像Content-Type失敗がある場合はカウンタをリセットする", async () => {
    const urls = [
      "https://example.com/a.png",
      "https://example.com/b.png",
      "https://example.com/c.png",
      "https://example.com/d.png",
    ];
    github.getPullRequest.mockResolvedValueOnce({
      number: 123,
      title: "Test PR",
      url: "https://github.com/octocat/hello-world/pull/123",
      body: urls.map((url, i) => `![${i}](${url})`).join("\n"),
      authorLogin: "author",
      mergedByLogin: "merger",
    });
    vi.mocked(extractUniqueImageUrls).mockReturnValue(urls);
    vi.mocked(buildImageBaseName).mockReturnValue("image.png");
    vi.mocked(downloadImageWithRetry)
      .mockResolvedValueOnce({ bytes: new Uint8Array([1]), contentType: "image/png" })
      .mockResolvedValueOnce({ bytes: new Uint8Array([2]), contentType: "text/html" })
      .mockResolvedValueOnce({ bytes: new Uint8Array([3]), contentType: "image/png" })
      .mockResolvedValueOnce({ bytes: new Uint8Array([4]), contentType: "image/png" });
    onedrive.saveBinary
      .mockRejectedValueOnce(new OneDriveApiError("quota exceeded", 507, "insufficientStorage"))
      .mockRejectedValueOnce(new OneDriveApiError("quota still exceeded", 507, "insufficientStorage"))
      .mockResolvedValueOnce({ name: "image.png", webUrl: "https://example.com/image.png" });
    onedrive.saveText
      .mockResolvedValueOnce({ name: "description.md", webUrl: "https://example.com/desc" })
      .mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });

    const response = await action({ request: buildRequest() } as never);
    expect(response.status).toBe(200);
    expect(downloadImageWithRetry).toHaveBeenCalledTimes(4);
    expect(onedrive.saveBinary).toHaveBeenCalledTimes(3);
    const archiveBody = JSON.parse(onedrive.saveText.mock.calls[1][1] as string) as {
      evidenceImages: Array<{ sourceUrl: string; status: string; errorReason: string | null }>;
    };
    expect(archiveBody.evidenceImages).toHaveLength(4);
    expect(archiveBody.evidenceImages[0]).toMatchObject({ status: "failed", errorReason: "ONEDRIVE_SAVE_FAILED" });
    expect(archiveBody.evidenceImages[1]).toMatchObject({
      status: "failed",
      errorReason: "UNSUPPORTED_CONTENT_TYPE: text/html",
    });
    expect(archiveBody.evidenceImages[2]).toMatchObject({ status: "failed", errorReason: "ONEDRIVE_SAVE_FAILED" });
    expect(archiveBody.evidenceImages[3]).toMatchObject({ status: "success" });
  });

  it.each([
    {
      status: 401,
      expected: "GitHub認証に失敗しました。トークンを確認してください。",
    },
    {
      status: 403,
      expected: "アクセスが拒否されました。権限またはレート制限を確認してください。",
    },
    {
      status: 404,
      expected: "指定されたPRが見つかりません。owner/repo/prNumber を確認してください。",
    },
    {
      status: 429,
      expected: "レート制限のため一時的に失敗しました。しばらくしてから再実行してください。",
    },
  ])("GitHub API error $status を適切なメッセージで返す", async ({ status, expected }) => {
    const githubError = Object.assign(new Error(`github error ${status}`), { status });
    github.getPullRequest.mockRejectedValue(githubError);

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; error: string; isAuthError: boolean };

    expect(response.status).toBe(status);
    expect(body.ok).toBe(false);
    expect(body.error).toBe(expected);
    expect(body.isAuthError).toBe(false);
  });

  it("GitHub 5xx はリトライ前提の定型メッセージで返す", async () => {
    const githubError = Object.assign(new Error("github internal error"), { status: 500 });
    github.getPullRequest.mockRejectedValue(githubError);

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; error: string; isAuthError: boolean };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("GitHub API への接続に失敗しました。しばらくしてから再実行してください。");
    expect(body.isAuthError).toBe(false);
  });

  it("GitHub ネットワークエラー（statusなし）も定型メッセージで返す", async () => {
    github.getPullRequest.mockRejectedValue(new Error("socket hang up"));

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; error: string; isAuthError: boolean };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("GitHub API への接続に失敗しました。しばらくしてから再実行してください。");
    expect(body.isAuthError).toBe(false);
  });
});

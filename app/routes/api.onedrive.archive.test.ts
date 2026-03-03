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
import { OAuthSessionStoreUnavailableError } from "../services/onedrive-oauth-session.server";
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
  listChildren: ReturnType<typeof vi.fn>;
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
      listChildren: vi.fn().mockResolvedValue([
        { name: "PR123-Test-PR", webUrl: "https://example.com/folder", isFolder: true },
      ]),
      getItem: vi.fn(),
      getText: vi.fn(),
    };
    vi.mocked(createOneDriveServiceFromEnv).mockResolvedValue(onedrive as never);
  });

  it("archive.json が無い場合は正式エラーを返す", async () => {
    onedrive.getItem.mockResolvedValueOnce(null);
    onedrive.getItem.mockResolvedValueOnce(null);

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      error: string;
      isAuthError: boolean;
      errorCode?: string;
    };

    expect(response.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toBe("OneDrive 上に保存済みの archive.json が見つかりません。");
    expect(body.errorCode).toBe("ARCHIVE_PR_NOT_FOUND");
  });

  it("archive.json から保存済み画像情報を返す", async () => {
    onedrive.getItem.mockImplementation(async (path: string) => {
      if (path.endsWith("/PullRequests/PR123-Test-PR")) {
        return { name: "PR123-Test-PR", webUrl: "https://example.com/folder" };
      }
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
        body: "- [x] CHK-01 one\nResult: OK\nEvidence: https://example.com/a.png?b=2&a=1",
        checklist: {
          items: [{ line: 1, text: "CHK-01 one", checked: true }],
        },
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
      body: string;
      checklistItems: Array<{ line: number; text: string; checked: boolean }>;
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
    expect(body.body).toContain("CHK-01");
    expect(body.checklistItems).toEqual([{ line: 1, text: "CHK-01 one", checked: true }]);
    expect(body.evidenceImages).toHaveLength(1);
    expect(body.evidenceImages[0]).toMatchObject({
      sourceUrl: "https://example.com/a.png?b=2&a=1",
      normalizedSourceUrl: "https://example.com/a.png?a=1&b=2",
      webUrl: "https://example.com/imgs/a.png",
      status: "success",
    });
    expect(body.evidenceImages[0].imageAccessToken).toMatch(/^[0-9a-f]{64}:[0-9]{10,16}$/);
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

  it("archive.json が不正JSONの場合は専用メッセージとエラーコードで502を返す", async () => {
    onedrive.getItem.mockResolvedValueOnce({ name: "PR123-Test-PR", webUrl: "https://example.com/folder" });
    onedrive.getItem.mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });
    onedrive.getText.mockResolvedValueOnce("{invalid-json");

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      error: string;
      isAuthError: boolean;
      errorCode?: string;
      errorMessage?: string;
    };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toBe(
      "保存済みの archive.json が壊れています。OneDrive 上の archive.json を削除してから再取得してください。",
    );
    expect(body.errorCode).toBe("ARCHIVE_JSON_INVALID");
    expect(body.errorMessage).toBeUndefined();
  });

  it("Redis障害は503で返し、archive取得へ進まない", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    onedrive.getDriveInfo.mockRejectedValue(new OAuthSessionStoreUnavailableError("redis down"));

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      error: string;
      isAuthError: boolean;
    };

    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toContain("OneDrive 認証基盤で一時障害");
    expect(github.getPullRequest).not.toHaveBeenCalled();
    expect(onedrive.getItem).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("archive.json の body が文字列でない場合は専用メッセージとエラーコードで502を返す", async () => {
    onedrive.getItem.mockResolvedValueOnce({ name: "PR123-Test-PR", webUrl: "https://example.com/folder" });
    onedrive.getItem.mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });
    onedrive.getText.mockResolvedValueOnce(
      JSON.stringify({
        body: 123,
        checklist: {
          items: [{ line: 1, text: "CHK-01 one", checked: true }],
        },
        evidenceImages: [],
      }),
    );

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      error: string;
      isAuthError: boolean;
      errorCode?: string;
      errorMessage?: string;
    };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toBe(
      "保存済みの archive.json が壊れています。OneDrive 上の archive.json を削除してから再取得してください。",
    );
    expect(body.errorCode).toBe("ARCHIVE_JSON_INVALID");
    expect(body.errorMessage).toBeUndefined();
  });

  it("archive.json の evidenceImages に非オブジェクト要素が含まれる場合は専用メッセージとエラーコードで502を返す", async () => {
    onedrive.getItem.mockResolvedValueOnce({ name: "PR123-Test-PR", webUrl: "https://example.com/folder" });
    onedrive.getItem.mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });
    onedrive.getText.mockResolvedValueOnce(
      JSON.stringify({
        body: "- [x] CHK-01 one",
        checklist: {
          items: [{ line: 1, text: "CHK-01 one", checked: true }],
        },
        evidenceImages: [null],
      }),
    );

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      error: string;
      isAuthError: boolean;
      errorCode?: string;
      errorMessage?: string;
    };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toBe(
      "保存済みの archive.json が壊れています。OneDrive 上の archive.json を削除してから再取得してください。",
    );
    expect(body.errorCode).toBe("ARCHIVE_JSON_INVALID");
    expect(body.errorMessage).toBeUndefined();
  });

  it("archive.json の evidenceImages に型不正なプロパティが含まれる場合は専用メッセージとエラーコードで502を返す", async () => {
    onedrive.getItem.mockResolvedValueOnce({ name: "PR123-Test-PR", webUrl: "https://example.com/folder" });
    onedrive.getItem.mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });
    onedrive.getText.mockResolvedValueOnce(
      JSON.stringify({
        body: "- [x] CHK-01 one",
        checklist: {
          items: [{ line: 1, text: "CHK-01 one", checked: true }],
        },
        evidenceImages: [{ sourceUrl: 123 }],
      }),
    );

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      error: string;
      isAuthError: boolean;
      errorCode?: string;
      errorMessage?: string;
    };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toBe(
      "保存済みの archive.json が壊れています。OneDrive 上の archive.json を削除してから再取得してください。",
    );
    expect(body.errorCode).toBe("ARCHIVE_JSON_INVALID");
    expect(body.errorMessage).toBeUndefined();
  });

  it("archive.json の Evidence と imgs の対応が壊れている場合は502を返す", async () => {
    onedrive.getItem.mockResolvedValueOnce({ name: "PR123-Test-PR", webUrl: "https://example.com/folder" });
    onedrive.getItem.mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });
    onedrive.getText.mockResolvedValueOnce(
      JSON.stringify({
        body: "- [x] CHK-01 one\nResult: OK\nEvidence: https://example.com/a.png",
        checklist: {
          items: [{ line: 1, text: "CHK-01 one", checked: true }],
        },
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
    onedrive.getItem.mockResolvedValueOnce(null);

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      error: string;
      isAuthError: boolean;
      errorCode?: string;
    };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.errorCode).toBe("ARCHIVE_EVIDENCE_INTEGRITY_INVALID");
  });

  it("success evidence がフォルダを指している場合は整合性エラーとして502を返す", async () => {
    onedrive.getItem.mockResolvedValueOnce({
      name: "PR123-Test-PR",
      webUrl: "https://example.com/folder",
      isFolder: true,
    });
    onedrive.getItem.mockResolvedValueOnce({
      name: "archive.json",
      webUrl: "https://example.com/archive",
      isFolder: false,
    });
    onedrive.getText.mockResolvedValueOnce(
      JSON.stringify({
        body: "- [x] CHK-01 one\nResult: OK\nEvidence: https://example.com/a.png",
        checklist: {
          items: [{ line: 1, text: "CHK-01 one", checked: true }],
        },
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
    onedrive.getItem.mockResolvedValueOnce({
      name: "a.png",
      webUrl: "https://example.com/imgs/a.png",
      isFolder: true,
    });

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      error: string;
      isAuthError: boolean;
      errorCode?: string;
    };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.errorCode).toBe("ARCHIVE_EVIDENCE_INTEGRITY_INVALID");
  });

  it("Evidence URL が failed レコードで網羅されている場合は整合性エラーにしない", async () => {
    onedrive.getItem.mockResolvedValueOnce({ name: "PR123-Test-PR", webUrl: "https://example.com/folder" });
    onedrive.getItem.mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });
    onedrive.getText.mockResolvedValueOnce(
      JSON.stringify({
        body: "- [ ] CHK-01 one\nResult: pending\nEvidence: https://example.com/a.png",
        checklist: {
          items: [{ line: 1, text: "CHK-01 one", checked: false }],
        },
        evidenceImages: [
          {
            sourceUrl: "https://example.com/a.png",
            status: "failed",
            fileName: null,
            onedrivePath: null,
            webUrl: null,
            errorReason: "download failed",
          },
        ],
      }),
    );

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: true;
      found: boolean;
      checklistItems: Array<{ line: number; text: string; checked: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.found).toBe(true);
    expect(body.checklistItems).toEqual([{ line: 1, text: "CHK-01 one", checked: false }]);
  });

  it("Evidence が非画像URLのみの場合は整合性エラーにしない", async () => {
    onedrive.getItem.mockResolvedValueOnce({ name: "PR123-Test-PR", webUrl: "https://example.com/folder" });
    onedrive.getItem.mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });
    onedrive.getText.mockResolvedValueOnce(
      JSON.stringify({
        body: "- [x] CHK-01 one\nResult: OK\nEvidence: https://example.com/spec",
        checklist: {
          items: [{ line: 1, text: "CHK-01 one", checked: true }],
        },
        evidenceImages: [],
      }),
    );

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: true;
      found: boolean;
      checklistItems: Array<{ line: number; text: string; checked: boolean }>;
      evidenceImages: unknown[];
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.found).toBe(true);
    expect(body.checklistItems).toEqual([{ line: 1, text: "CHK-01 one", checked: true }]);
    expect(body.evidenceImages).toEqual([]);
  });

  it("checklist item の text が空文字でも archive.json を有効として扱う", async () => {
    onedrive.getItem.mockResolvedValueOnce({ name: "PR123-Test-PR", webUrl: "https://example.com/folder" });
    onedrive.getItem.mockResolvedValueOnce({ name: "archive.json", webUrl: "https://example.com/archive" });
    onedrive.getText.mockResolvedValueOnce(
      JSON.stringify({
        body: "- [ ] ",
        checklist: {
          items: [{ line: 1, text: "", checked: false }],
        },
        evidenceImages: [],
      }),
    );

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: true;
      found: boolean;
      checklistItems: Array<{ line: number; text: string; checked: boolean }>;
    };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.found).toBe(true);
    expect(body.checklistItems).toEqual([{ line: 1, text: "", checked: false }]);
  });

  it("PullRequests 配下に対象PRフォルダが無い場合は正式エラーを返す", async () => {
    onedrive.getItem.mockResolvedValueOnce(null);
    onedrive.listChildren.mockResolvedValueOnce([{ name: "PR122-Old", webUrl: "https://example.com/old" }]);

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      error: string;
      isAuthError: boolean;
      errorCode?: string;
    };

    expect(response.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toBe("OneDrive 上に保存済みのPRデータが見つかりません。");
    expect(body.errorCode).toBe("ARCHIVE_PR_NOT_FOUND");
  });

  it("PullRequests フォルダ自体が404の場合も正式エラーを返す", async () => {
    onedrive.getItem.mockResolvedValueOnce(null);
    onedrive.listChildren.mockRejectedValueOnce({
      status: 404,
      message: "OneDrive API error (404) [code=itemNotFound]",
    });

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      error: string;
      isAuthError: boolean;
      errorCode?: string;
    };

    expect(response.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toBe("OneDrive 上に保存済みのPRデータが見つかりません。");
    expect(body.errorCode).toBe("ARCHIVE_PR_NOT_FOUND");
  });

  it("同じPR番号の保存フォルダが複数ある場合は409を返す", async () => {
    onedrive.getItem.mockResolvedValueOnce(null);
    onedrive.listChildren.mockResolvedValueOnce([
      { name: "PR123-OldTitle", webUrl: "https://example.com/old", isFolder: true },
      { name: "PR123-NewTitle", webUrl: "https://example.com/new", isFolder: true },
    ]);

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as {
      ok: false;
      error: string;
      isAuthError: boolean;
      errorCode?: string;
    };

    expect(response.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.isAuthError).toBe(false);
    expect(body.error).toBe(
      "OneDrive 上に同じPR番号の保存フォルダが複数あり、表示対象を特定できません。不要なフォルダを整理してください。",
    );
    expect(body.errorCode).toBe("ARCHIVE_PR_FOLDER_CONFLICT");
  });

  it("GitHub取得失敗時は OneDrive プレフィックス探索へフォールバックする", async () => {
    github.getPullRequest.mockRejectedValueOnce(new Error("not found"));
    onedrive.listChildren.mockResolvedValueOnce([
      { name: "PR123-Manual", webUrl: "https://example.com/folder", isFolder: true },
    ]);
    onedrive.getItem.mockImplementation(async (path: string) => {
      if (path.endsWith("/archive.json")) {
        return { name: "archive.json", webUrl: "https://example.com/archive" };
      }
      return null;
    });
    onedrive.getText.mockResolvedValueOnce(
      JSON.stringify({
        body: "",
        checklist: { items: [] },
        evidenceImages: [],
      }),
    );

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: true; found: boolean };
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.found).toBe(true);
  });

  it("プレフィックス一致するファイルは競合候補に含めずフォルダを優先する", async () => {
    github.getPullRequest.mockRejectedValueOnce(new Error("not found"));
    onedrive.listChildren.mockResolvedValueOnce([
      { name: "PR123-notes.txt", webUrl: "https://example.com/file", isFolder: false },
      { name: "PR123-Manual", webUrl: "https://example.com/folder", isFolder: true },
    ]);
    onedrive.getItem.mockImplementation(async (path: string) => {
      if (path.endsWith("/archive.json")) {
        return { name: "archive.json", webUrl: "https://example.com/archive" };
      }
      return null;
    });
    onedrive.getText.mockResolvedValueOnce(
      JSON.stringify({
        body: "",
        checklist: { items: [] },
        evidenceImages: [],
      }),
    );

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: true; found: boolean };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.found).toBe(true);
  });

  it("GitHub算出の優先パスに同名ファイルしか無い場合はフォルダ探索へフォールバックする", async () => {
    onedrive.getItem.mockImplementation(async (path: string) => {
      if (path.endsWith("/PullRequests/PR123-Test-PR")) {
        return { name: "PR123-Test-PR", webUrl: "https://example.com/file", isFolder: false };
      }
      if (path.endsWith("/archive.json")) {
        return { name: "archive.json", webUrl: "https://example.com/archive", isFolder: false };
      }
      return null;
    });
    onedrive.listChildren.mockResolvedValueOnce([
      { name: "PR123-Test-PR", webUrl: "https://example.com/file", isFolder: false },
      { name: "PR123-ActualFolder", webUrl: "https://example.com/folder", isFolder: true },
    ]);
    onedrive.getText.mockResolvedValueOnce(
      JSON.stringify({
        body: "",
        checklist: { items: [] },
        evidenceImages: [],
      }),
    );

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: true; found: boolean };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.found).toBe(true);
  });
});

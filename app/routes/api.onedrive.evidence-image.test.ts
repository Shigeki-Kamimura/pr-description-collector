/**
 * /api/onedrive/evidence-image ルートのテスト
 *
 * このファイルを用意した理由:
 * - 保存済みエビデンス画像の配信契約（200/401/403/404/415/429/400）を固定し、表示回帰を防ぐため。
 *
 * このファイルが使われる場面:
 * - `npm run test` 実行時に、カード表示用画像APIの成功系と主要失敗系を検証するとき。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loader } from "./api.onedrive.evidence-image";
import { createOneDriveServiceFromEnv, OneDriveApiError } from "../services/onedrive.server";
import { signEvidenceImagePath } from "../services/evidence-image-token.server";

vi.mock("../services/onedrive.server", () => ({
  createOneDriveServiceFromEnv: vi.fn(),
  OneDriveApiError: class OneDriveApiError extends Error {
    status: number;
    code?: string;
    retryAfterSeconds?: number;
    retryAfterRaw?: string;
    retryAfterAtIso?: string;
    constructor(
      message: string,
      status: number,
      code?: string,
      retryAfterSeconds?: number,
      retryAfterRaw?: string,
      retryAfterAtIso?: string,
    ) {
      super(message);
      this.name = "OneDriveApiError";
      this.status = status;
      this.code = code;
      this.retryAfterSeconds = retryAfterSeconds;
      this.retryAfterRaw = retryAfterRaw;
      this.retryAfterAtIso = retryAfterAtIso;
    }
  },
}));

type MockOneDriveService = {
  getBinary: ReturnType<typeof vi.fn>;
};

function buildEvidenceRequest(path: string, token?: string): Request {
  const resolvedToken = token ?? signEvidenceImagePath(path);
  const params = new URLSearchParams({ path, token: resolvedToken });
  return new Request(`http://localhost/api/onedrive/evidence-image?${params.toString()}`);
}

describe("api.onedrive.evidence-image loader", () => {
  let onedrive: MockOneDriveService;
  const originalBaseFolder = process.env.ONEDRIVE_BASE_FOLDER;
  const originalWorkFolder = process.env.ONEDRIVE_WORK_FOLDER;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ONEDRIVE_BASE_FOLDER = "project";
    delete process.env.ONEDRIVE_WORK_FOLDER;
    onedrive = {
      getBinary: vi.fn(),
    };
    vi.mocked(createOneDriveServiceFromEnv).mockResolvedValue(onedrive as never);
  });

  afterAll(() => {
    if (originalBaseFolder === undefined) {
      delete process.env.ONEDRIVE_BASE_FOLDER;
    } else {
      process.env.ONEDRIVE_BASE_FOLDER = originalBaseFolder;
    }
    if (originalWorkFolder === undefined) {
      delete process.env.ONEDRIVE_WORK_FOLDER;
    } else {
      process.env.ONEDRIVE_WORK_FOLDER = originalWorkFolder;
    }
  });

  it("保存済み画像を 200 で返す", async () => {
    onedrive.getBinary.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    });

    const request = buildEvidenceRequest("project/repo/PullRequests/PR1-test/imgs/a.png");
    const response = await loader({ request } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(onedrive.getBinary).toHaveBeenCalledWith("project/repo/PullRequests/PR1-test/imgs/a.png");
  });

  it("path が無効な場合は 400 を返す", async () => {
    const request = new Request("http://localhost/api/onedrive/evidence-image?path=..");
    const response = await loader({ request } as never);

    expect(response.status).toBe(400);
    expect(createOneDriveServiceFromEnv).not.toHaveBeenCalled();
  });

  it("許可範囲外の path は 400 を返す", async () => {
    const request = new Request("http://localhost/api/onedrive/evidence-image?path=tmp/repo/a.png&token=00");
    const response = await loader({ request } as never);

    expect(response.status).toBe(400);
    expect(createOneDriveServiceFromEnv).not.toHaveBeenCalled();
  });

  it("token が未指定の場合は 400 を返す", async () => {
    const request = new Request(
      "http://localhost/api/onedrive/evidence-image?path=project/repo/PullRequests/PR1-test/imgs/a.png",
    );
    const response = await loader({ request } as never);

    expect(response.status).toBe(400);
    expect(createOneDriveServiceFromEnv).not.toHaveBeenCalled();
  });

  it("token が不正な場合は 403 を返す", async () => {
    const path = "project/repo/PullRequests/PR1-test/imgs/a.png";
    const wrongToken = signEvidenceImagePath("project/repo/PullRequests/PR1-test/imgs/other.png");
    const request = buildEvidenceRequest(path, wrongToken);
    const response = await loader({ request } as never);

    expect(response.status).toBe(403);
    expect(createOneDriveServiceFromEnv).not.toHaveBeenCalled();
  });

  it("OneDrive の 404 は 404 を返す", async () => {
    onedrive.getBinary.mockRejectedValue(new OneDriveApiError("not found", 404, "itemNotFound"));

    const request = buildEvidenceRequest("project/repo/PullRequests/PR1-test/imgs/missing.png");
    const response = await loader({ request } as never);

    expect(response.status).toBe(404);
  });

  it("認証エラーは 401 を返す", async () => {
    onedrive.getBinary.mockRejectedValue(
      new Error("OneDrive API error (401) [code=InvalidAuthenticationToken]: token expired"),
    );

    const request = buildEvidenceRequest("project/repo/PullRequests/PR1-test/imgs/a.png");
    const response = await loader({ request } as never);
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(body).toBe("onedrive auth required");
  });

  it("権限不足は 403 を返す", async () => {
    onedrive.getBinary.mockRejectedValue(new OneDriveApiError("forbidden", 403, "accessDenied"));
    const request = buildEvidenceRequest("project/repo/PullRequests/PR1-test/imgs/a.png");
    const response = await loader({ request } as never);
    const body = await response.text();

    expect(response.status).toBe(403);
    expect(body).toBe("onedrive access denied");
  });

  it("非画像 content-type は 415 を返す", async () => {
    onedrive.getBinary.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "text/html; charset=utf-8",
    });

    const request = buildEvidenceRequest("project/repo/PullRequests/PR1-test/imgs/a.png");
    const response = await loader({ request } as never);

    expect(response.status).toBe(415);
  });

  it("SVG content-type は 415 を返す", async () => {
    onedrive.getBinary.mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/svg+xml",
    });

    const request = buildEvidenceRequest("project/repo/PullRequests/PR1-test/imgs/a.svg");
    const response = await loader({ request } as never);

    expect(response.status).toBe(415);
  });

  it("429 は Retry-After を返す", async () => {
    onedrive.getBinary.mockRejectedValue(new OneDriveApiError("throttled", 429, "activityLimitReached", 8));
    const request = buildEvidenceRequest("project/repo/PullRequests/PR1-test/imgs/a.png");
    const response = await loader({ request } as never);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("8");
  });

  it("429 の Retry-After が日時形式でもそのまま返す", async () => {
    const retryAfterDate = "Wed, 21 Oct 2026 07:28:00 GMT";
    onedrive.getBinary.mockRejectedValue(
      new OneDriveApiError("throttled", 429, "activityLimitReached", undefined, retryAfterDate),
    );
    const request = buildEvidenceRequest("project/repo/PullRequests/PR1-test/imgs/a.png");
    const response = await loader({ request } as never);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(retryAfterDate);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createOneDriveService } from "./onedrive.server";

describe("onedrive service error handling", () => {
  const originalGetBinaryMaxBytes = process.env.ONEDRIVE_GET_BINARY_MAX_BYTES;

  afterEach(() => {
    if (originalGetBinaryMaxBytes === undefined) {
      delete process.env.ONEDRIVE_GET_BINARY_MAX_BYTES;
    } else {
      process.env.ONEDRIVE_GET_BINARY_MAX_BYTES = originalGetBinaryMaxBytes;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("deleteItem は 404 を成功扱いにする", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const service = createOneDriveService({ accessToken: "token" });

    await expect(service.deleteItem("a/b.txt")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deleteItem は 404 以外を OneDriveApiError として返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "generalException", message: "delete failed" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = createOneDriveService({ accessToken: "token" });

    await expect(service.deleteItem("a/b.txt")).rejects.toMatchObject({
      name: "OneDriveApiError",
      status: 500,
      code: "generalException",
    });
  });

  it("getText の失敗は OneDriveApiError で status を保持する", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "itemNotFound", message: "not found" } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = createOneDriveService({ accessToken: "token" });

    await expect(service.getText("missing.txt")).rejects.toMatchObject({
      name: "OneDriveApiError",
      status: 404,
      code: "itemNotFound",
    });
  });

  it("getBinary は content-type と bytes を返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([7, 8, 9]), {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = createOneDriveService({ accessToken: "token" });

    const result = await service.getBinary("evidence/image.png");
    expect(result.contentType).toContain("image/png");
    expect(Array.from(result.bytes)).toEqual([7, 8, 9]);
  });

  it("getBinary の 429 は retryAfterSeconds を保持する", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "activityLimitReached", message: "throttled" },
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "12",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = createOneDriveService({ accessToken: "token" });

    await expect(service.getBinary("evidence/image.png")).rejects.toMatchObject({
      name: "OneDriveApiError",
      status: 429,
      retryAfterSeconds: 12,
      retryAfterRaw: "12",
    });
  });

  it("getBinary の 429 は Retry-After 日時形式も保持する", async () => {
    const retryAfterDate = "Wed, 21 Oct 2026 07:28:00 GMT";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "activityLimitReached", message: "throttled" },
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": retryAfterDate,
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = createOneDriveService({ accessToken: "token" });

    await expect(service.getBinary("evidence/image.png")).rejects.toMatchObject({
      name: "OneDriveApiError",
      status: 429,
      retryAfterRaw: retryAfterDate,
      retryAfterAtIso: "2026-10-21T07:28:00.000Z",
    });
  });

  it("getBinary は content-length が上限超過の場合に 413 を返す", async () => {
    process.env.ONEDRIVE_GET_BINARY_MAX_BYTES = "4";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
          "Content-Length": "5",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = createOneDriveService({ accessToken: "token" });

    await expect(service.getBinary("evidence/large.png")).rejects.toMatchObject({
      name: "OneDriveApiError",
      status: 413,
      code: "payloadTooLarge",
    });
  });

  it("getBinary は content-length 未設定でも実サイズ超過時に 413 を返す", async () => {
    process.env.ONEDRIVE_GET_BINARY_MAX_BYTES = "4";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4, 5]), {
        status: 200,
        headers: {
          "Content-Type": "image/png",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = createOneDriveService({ accessToken: "token" });

    await expect(service.getBinary("evidence/large.png")).rejects.toMatchObject({
      name: "OneDriveApiError",
      status: 413,
      code: "payloadTooLarge",
    });
  });

  it("getItem は 404 を null で返す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "itemNotFound", message: "not found" } }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = createOneDriveService({ accessToken: "token" });
    await expect(service.getItem("missing.png")).resolves.toBeNull();
  });

  it("listChildren は nameStartsWith を OData filter に変換して呼び出す", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ value: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const service = createOneDriveService({ accessToken: "token" });

    await service.listChildren("work/project/repo/PullRequests", { nameStartsWith: "PR123-" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestUrl).toContain("/children?");
    expect(requestUrl).toContain("%24filter=startswith%28name%2C%27PR123-%27%29");
  });

  it("listChildren は不正な nameStartsWith を拒否する", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = createOneDriveService({ accessToken: "token" });

    await expect(
      service.listChildren("work/project/repo/PullRequests", { nameStartsWith: "PR123-') or name eq '" }),
    ).rejects.toThrow("OneDrive listChildren: nameStartsWith contains invalid characters");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("listChildren は @odata.nextLink を辿って全ページを取得する", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [{ id: "1", name: "PR123-Page1", webUrl: "https://example.com/1" }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/drive/root:/next-page",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [{ id: "2", name: "PR123-Page2", webUrl: "https://example.com/2" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const service = createOneDriveService({ accessToken: "token" });

    const items = await service.listChildren("work/project/repo/PullRequests", { nameStartsWith: "PR123-" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(items.map((item) => item.name)).toEqual(["PR123-Page1", "PR123-Page2"]);
    const [firstUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [secondUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(firstUrl).toContain("/children?");
    expect(secondUrl).toBe("https://graph.microsoft.com/v1.0/me/drive/root:/next-page");
  });

  it("saveBinary は content-type を指定して保存する", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "folder-1",
            name: "evidence",
            folder: {},
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "img-1",
            name: "image.png",
            webUrl: "https://example.com/image.png",
            size: 3,
            file: { mimeType: "image/png" },
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const service = createOneDriveService({ accessToken: "token" });
    await service.saveBinary("evidence/image.png", new Uint8Array([1, 2, 3]), "image/png");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const saveCall = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(saveCall[0]).toContain("/content");
    expect(saveCall[1].headers).toMatchObject({
      "Content-Type": "image/png",
      "If-None-Match": "*",
    });
  });
});

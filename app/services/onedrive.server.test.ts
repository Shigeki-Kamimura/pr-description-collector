import { afterEach, describe, expect, it, vi } from "vitest";
import { createOneDriveService, OneDriveApiError } from "./onedrive.server";

describe("onedrive service error handling", () => {
  afterEach(() => {
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
    expect(saveCall[1].headers).toMatchObject({ "Content-Type": "image/png" });
  });
});

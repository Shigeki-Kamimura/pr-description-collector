/**
 * evidence-images サービスの回帰防止テスト。
 *
 * このファイルを用意した理由:
 * - 画像URL抽出の重複排除、ダウンロード再試行、拡張子補完の契約を固定し、
 *   Issue #25 の要件回帰を防ぐため。
 *
 * このファイルが使われる場面:
 * - `npm run test` で画像処理サービスの仕様を継続検証するとき。
 */
import { describe, expect, it, vi } from "vitest";
import { buildImageBaseName, downloadImageWithRetry, extractUniqueImageUrls } from "./evidence-images.server";

describe("extractUniqueImageUrls", () => {
  it("Markdown画像URLを初出順で抽出し重複除去する", () => {
    const markdown = `
![a](https://example.com/a.png)
![dup](https://example.com/a.png "title")
text
<img src="https://example.com/b.jpg" />
![skip](/relative/path.png)
`;
    expect(extractUniqueImageUrls(markdown)).toEqual([
      "https://example.com/a.png",
      "https://example.com/b.jpg",
    ]);
  });

  it("URLに括弧が含まれても正しく抽出する", () => {
    const markdown = "![img](https://example.com/image_(v2).png \"sample\")";
    expect(extractUniqueImageUrls(markdown)).toEqual(["https://example.com/image_(v2).png"]);
  });

  it("Evidence行のプレーンURL（GitHub user-attachments）を抽出する", () => {
    const markdown = "Evidence: https://github.com/user-attachments/assets/c947f7d9-bb2b-406b-86af-f123753df131";
    expect(extractUniqueImageUrls(markdown)).toEqual([
      "https://github.com/user-attachments/assets/c947f7d9-bb2b-406b-86af-f123753df131",
    ]);
  });

  it("非画像URLのプレーンリンクは抽出しない", () => {
    const markdown = "PR: https://github.com/Shigeki-Kamimura/pr-description-collector/pull/10";
    expect(extractUniqueImageUrls(markdown)).toEqual([]);
  });
});

describe("downloadImageWithRetry", () => {
  it("一時エラー後の再試行で成功する", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );
    const result = await downloadImageWithRetry("https://example.com/a.png", {
      timeoutMs: 1000,
      maxAttempts: 3,
      fetchFn,
    });
    expect("ok" in result).toBe(false);
    if ("ok" in result) return;
    expect(result.contentType).toBe("image/png");
    expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("タイムアウト時は TIMEOUT を返す", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      await new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
      return new Response();
    });
    const result = await downloadImageWithRetry("https://example.com/slow.png", {
      timeoutMs: 1,
      maxAttempts: 1,
      fetchFn,
    });
    expect(result).toEqual({ ok: false, errorReason: "TIMEOUT" });
  });
});

describe("buildImageBaseName", () => {
  it("URL末尾が拡張子なしのとき content-type から補完する", () => {
    expect(buildImageBaseName("https://example.com/path/evidence", "image/jpeg")).toBe("evidence.jpg");
  });
});

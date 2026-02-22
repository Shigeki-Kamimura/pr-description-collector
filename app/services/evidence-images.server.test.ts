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
    vi.useFakeTimers();
    try {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response("busy", { status: 503 }))
        .mockResolvedValueOnce(
          new Response(new Uint8Array([1, 2, 3]), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        );
      const resultPromise = downloadImageWithRetry("https://github.com/user-attachments/assets/a.png", {
        timeoutMs: 1000,
        maxAttempts: 3,
        fetchFn,
      });
      await Promise.resolve();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;
      expect("ok" in result).toBe(false);
      if ("ok" in result) return;
      expect(result.contentType).toBe("image/png");
      expect(Array.from(result.bytes)).toEqual([1, 2, 3]);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("Retry-After が極端に大きくても timeoutMs 上限で再試行する", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response("busy", {
            status: 429,
            headers: { "retry-after": "86400" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(new Uint8Array([1]), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        );
      const resultPromise = downloadImageWithRetry("https://github.com/user-attachments/assets/retry.png", {
        timeoutMs: 2_000,
        maxAttempts: 2,
        fetchFn,
      });

      await Promise.resolve();
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;
      expect("ok" in result).toBe(false);
      if ("ok" in result) return;
      expect(result.bytes.byteLength).toBe(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("許可ホストへのリダイレクトは追従して取得する", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://user-images.githubusercontent.com/image.png",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([9, 9]), {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );
    const result = await downloadImageWithRetry("https://github.com/user-attachments/assets/r1", {
      maxAttempts: 1,
      fetchFn,
    });
    expect("ok" in result).toBe(false);
    if ("ok" in result) return;
    expect(Array.from(result.bytes)).toEqual([9, 9]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("非許可ホストへのリダイレクトは BLOCKED_UNTRUSTED_HOST で拒否する", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://example.com/not-allowed.png",
          },
        }),
      );
    const result = await downloadImageWithRetry("https://github.com/user-attachments/assets/r2", {
      maxAttempts: 1,
      fetchFn,
    });
    expect(result).toEqual({ ok: false, errorReason: "BLOCKED_UNTRUSTED_HOST" });
    expect(fetchFn).toHaveBeenCalledTimes(1);
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
    const result = await downloadImageWithRetry("https://github.com/user-attachments/assets/slow.png", {
      timeoutMs: 1,
      maxAttempts: 1,
      fetchFn,
    });
    expect(result).toEqual({ ok: false, errorReason: "TIMEOUT" });
  });

  it("localhost 宛てURLは SSRF ガードで拒否する", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const result = await downloadImageWithRetry("https://localhost/internal.png", {
      fetchFn,
    });
    expect(result).toEqual({ ok: false, errorReason: "BLOCKED_PRIVATE_HOST" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("リンクローカルIP宛てURLは SSRF ガードで拒否する", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const result = await downloadImageWithRetry("https://169.254.169.254/latest/meta-data/", {
      fetchFn,
    });
    expect(result).toEqual({ ok: false, errorReason: "BLOCKED_PRIVATE_HOST" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("http スキームは UNSUPPORTED_PROTOCOL で拒否する", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const result = await downloadImageWithRetry("http://github.com/user-attachments/assets/a.png", {
      fetchFn,
    });
    expect(result).toEqual({ ok: false, errorReason: "UNSUPPORTED_PROTOCOL" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("許可ドメイン外のURLは拒否する", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const result = await downloadImageWithRetry("https://example.com/a.png", {
      fetchFn,
    });
    expect(result).toEqual({ ok: false, errorReason: "BLOCKED_UNTRUSTED_HOST" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("Content-Length が上限超過なら即時に失敗する", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([1]), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(11),
        },
      }),
    );
    const result = await downloadImageWithRetry("https://github.com/user-attachments/assets/large.png", {
      maxBytes: 10,
      maxAttempts: 1,
      fetchFn,
    });
    expect(result).toEqual({ ok: false, errorReason: "PAYLOAD_TOO_LARGE" });
  });

  it("Content-Length 未設定でも実バイトが上限超過なら失敗する", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5, 6]));
        controller.enqueue(new Uint8Array([7, 8, 9, 10, 11]));
        controller.close();
      },
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "content-type": "image/png" },
      }),
    );
    const result = await downloadImageWithRetry("https://github.com/user-attachments/assets/stream.png", {
      maxBytes: 10,
      maxAttempts: 1,
      fetchFn,
    });
    expect(result).toEqual({ ok: false, errorReason: "PAYLOAD_TOO_LARGE" });
  });

  it("サイズが上限以下なら成功する", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "4",
        },
      }),
    );
    const result = await downloadImageWithRetry("https://github.com/user-attachments/assets/small.png", {
      maxBytes: 4,
      maxAttempts: 1,
      fetchFn,
    });
    expect("ok" in result).toBe(false);
    if ("ok" in result) return;
    expect(result.bytes.byteLength).toBe(4);
  });
});

describe("buildImageBaseName", () => {
  it("URL末尾が拡張子なしのとき content-type から補完する", () => {
    expect(buildImageBaseName("https://example.com/path/evidence", "image/jpeg")).toBe("evidence.jpg");
  });

  it("AVIF は拡張子を補完する", () => {
    expect(buildImageBaseName("https://example.com/path/evidence", "image/avif")).toBe("evidence.avif");
  });

  it("SVG は保存対象外のため拡張子を補完しない", () => {
    expect(buildImageBaseName("https://example.com/path/evidence", "image/svg+xml")).toBe("evidence");
  });
});

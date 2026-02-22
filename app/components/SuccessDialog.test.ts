import { describe, expect, it } from "vitest";
import { formatEvidenceImagesMessage } from "./SuccessDialog";

describe("formatEvidenceImagesMessage", () => {
  it("画像対象が0件なら対象なしメッセージを返す", () => {
    expect(formatEvidenceImagesMessage({ total: 0, success: 0, failed: 0 })).toBe(
      "画像は対象が0件でした。",
    );
  });

  it("全失敗なら保存できなかったメッセージを返す", () => {
    expect(formatEvidenceImagesMessage({ total: 16, success: 0, failed: 16 })).toBe(
      "画像は保存できませんでした（成功: 0件 / 失敗: 16件）。",
    );
  });

  it("一部または全件成功なら従来メッセージを返す", () => {
    expect(formatEvidenceImagesMessage({ total: 3, success: 2, failed: 1 })).toBe(
      "画像を保存しました（成功: 2件 / 失敗: 1件）。",
    );
  });
});

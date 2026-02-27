import { describe, expect, it } from "vitest";
import { formatArchiveFilesMessage, formatEvidenceImagesMessage } from "./SuccessDialog";

describe("formatEvidenceImagesMessage", () => {
  it("画像対象が0件なら対象なしメッセージを返す", () => {
    expect(formatEvidenceImagesMessage({ total: 0, success: 0, failed: 0, alreadySaved: 0 })).toBe(
      "画像は対象が0件でした。",
    );
  });

  it("全失敗なら保存できなかったメッセージを返す", () => {
    expect(formatEvidenceImagesMessage({ total: 16, success: 0, failed: 16, alreadySaved: 0 })).toBe(
      "画像は保存できませんでした（成功: 0件 / 失敗: 16件）。",
    );
  });

  it("一部または全件成功なら従来メッセージを返す", () => {
    expect(formatEvidenceImagesMessage({ total: 3, success: 2, failed: 1, alreadySaved: 0 })).toBe(
      "画像を保存しました（成功: 2件 / 失敗: 1件）。",
    );
  });

  it("全件が保存済みなら保存済みメッセージを返す", () => {
    expect(formatEvidenceImagesMessage({ total: 2, success: 2, failed: 0, alreadySaved: 2 })).toBe(
      "画像は保存済みです（2件）。",
    );
  });

  it("保存と保存済みが混在する場合は両方のメッセージを返す", () => {
    expect(formatEvidenceImagesMessage({ total: 3, success: 3, failed: 0, alreadySaved: 1 })).toBe(
      "画像を保存しました（成功: 3件 / 失敗: 0件）。 画像は保存済みです（1件）。",
    );
  });
});

describe("formatArchiveFilesMessage", () => {
  it("通常時は保存完了メッセージを返す", () => {
    expect(
      formatArchiveFilesMessage(
        { descriptionMd: false, archiveJson: false },
        { total: 1, success: 1, failed: 0, alreadySaved: 0 },
      ),
    ).toBe("description.md と archive.json を保存しました。");
  });

  it("md/json保存済みかつ画像成功時は追加メッセージを返す", () => {
    expect(
      formatArchiveFilesMessage(
        { descriptionMd: true, archiveJson: true },
        { total: 2, success: 2, failed: 0, alreadySaved: 1 },
      ),
    ).toBe("description.md と archive.json は保存済みでした。 画像も保存できています。");
  });
});

import { describe, expect, it } from "vitest";
import { checklistResultText, resolveChecklistCardImageUrl } from "../components/ChecklistCard";
import {
  extractEvidenceImageByChecklistLine,
  extractResultByChecklistLine,
  mapPrimaryImageErrorToDialog,
} from "./_index";

describe("resolveChecklistCardImageUrl", () => {
  it("主URLが有効なら主URLを返す", () => {
    expect(resolveChecklistCardImageUrl("https://example.com/evidence.png", "https://fallback.example.com/a.png")).toBe(
      "https://example.com/evidence.png",
    );
  });

  it("主URLが無効ならフォールバックURLを返す", () => {
    expect(resolveChecklistCardImageUrl("not-url", "https://fallback.example.com/a.png")).toBe(
      "https://fallback.example.com/a.png",
    );
  });

  it("相対URL（アプリ内API）は有効URLとして扱う", () => {
    expect(
      resolveChecklistCardImageUrl(
        "/api/onedrive/evidence-image?path=project/repo/PullRequests/PR1-test/imgs/a.png",
        null,
      ),
    ).toBe("/api/onedrive/evidence-image?path=project/repo/PullRequests/PR1-test/imgs/a.png");
  });

  it("主URL/フォールバックともに無効なら null を返す", () => {
    expect(resolveChecklistCardImageUrl("", "ftp://example.com/evidence.png")).toBeNull();
    expect(resolveChecklistCardImageUrl("not-url", "  ")).toBeNull();
  });
});

describe("checklistResultText", () => {
  it("チェック状態に応じた結果文言を返す", () => {
    expect(checklistResultText(true)).toBe("完了");
    expect(checklistResultText(false)).toBe("未完了");
  });
});

describe("extractResultByChecklistLine", () => {
  it("チェック項目直下の Result 行を行番号で抽出する", () => {
    const markdown = [
      "- [x] CHK-06 parseChecklistFromMarkdown が `- [ ] / - [x]` を抽出できる",
      "Result: 表示を確認",
      "Evidence: https://example.com/evidence.png",
    ].join("\n");

    expect(extractResultByChecklistLine(markdown)).toEqual({ 1: "表示を確認" });
  });

  it("Result がない項目は抽出結果に含めない", () => {
    const markdown = [
      "- [ ] CHK-01 one",
      "Evidence: https://example.com/1.png",
      "- [x] CHK-02 two",
      "Result: OK",
    ].join("\n");

    expect(extractResultByChecklistLine(markdown)).toEqual({ 3: "OK" });
  });

  it("全角コロンの Result も抽出する", () => {
    const markdown = [
      "- [x] CHK-03 three",
      "Result： 全角コロンでも抽出",
    ].join("\n");

    expect(extractResultByChecklistLine(markdown)).toEqual({ 1: "全角コロンでも抽出" });
  });
});

describe("extractEvidenceImageByChecklistLine", () => {
  it("Evidence: の生URLを抽出する", () => {
    const markdown = [
      "- [x] CHK-01 one",
      "Result: OK",
      "Evidence: https://example.com/evidence-1.png",
    ].join("\n");

    expect(extractEvidenceImageByChecklistLine(markdown)).toEqual({
      1: "https://example.com/evidence-1.png",
    });
  });

  it("Evidence: のMarkdown画像構文からURLを抽出する", () => {
    const markdown = [
      "- [x] CHK-02 two",
      "Evidence: ![img](https://example.com/evidence-2.png)",
    ].join("\n");

    expect(extractEvidenceImageByChecklistLine(markdown)).toEqual({
      1: "https://example.com/evidence-2.png",
    });
  });

  it("無効URLやEvidence未記載は抽出しない", () => {
    const markdown = [
      "- [x] CHK-03 three",
      "Evidence: ftp://example.com/evidence-3.png",
      "- [ ] CHK-04 four",
      "Result: pending",
    ].join("\n");

    expect(extractEvidenceImageByChecklistLine(markdown)).toEqual({});
  });
});

describe("mapPrimaryImageErrorToDialog", () => {
  it("中程度以上のエラーのみダイアログ情報を返す", () => {
    expect(mapPrimaryImageErrorToDialog(401)).toMatchObject({ isAuthError: true });
    expect(mapPrimaryImageErrorToDialog(403)).toMatchObject({ isAuthError: false });
    expect(mapPrimaryImageErrorToDialog(429)).toMatchObject({ isAuthError: false });
    expect(mapPrimaryImageErrorToDialog(502)).toMatchObject({ isAuthError: false });
  });

  it("低優先度ステータスは null を返す", () => {
    expect(mapPrimaryImageErrorToDialog(400)).toBeNull();
    expect(mapPrimaryImageErrorToDialog(404)).toBeNull();
    expect(mapPrimaryImageErrorToDialog(415)).toBeNull();
  });
});

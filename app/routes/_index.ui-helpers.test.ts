import { describe, expect, it } from "vitest";
import { checklistResultText, resolveChecklistCardImageUrl } from "../components/ChecklistCard";
import {
  extractEvidenceImageByChecklistLine,
  extractResultByChecklistLine,
  mapPrimaryImageErrorToDialog,
  shouldAutoLookupArchive,
  shouldShowUploadAllEvidenceFailedError,
  shouldUseArchiveChecklistFallback,
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

describe("shouldUseArchiveChecklistFallback", () => {
  it("GitHub取得失敗系の action error なら true", () => {
    expect(
      shouldUseArchiveChecklistFallback({
        ok: false,
        error: "GitHub API への接続に失敗しました。しばらくしてから再実行してください。",
      }),
    ).toBe(true);
  });

  it("入力エラー/CSRF/未実行は false", () => {
    expect(
      shouldUseArchiveChecklistFallback({
        ok: false,
        error: "owner/repo/prNumber を正しく指定してください",
      }),
    ).toBe(false);
    expect(
      shouldUseArchiveChecklistFallback({
        ok: false,
        error: "不正なリクエストです。ページを再読み込みして再試行してください。",
      }),
    ).toBe(false);
    expect(shouldUseArchiveChecklistFallback(undefined)).toBe(false);
  });
});

describe("shouldShowUploadAllEvidenceFailedError", () => {
  it("画像対象があり成功0/失敗ありの場合は true", () => {
    expect(
      shouldShowUploadAllEvidenceFailedError({
        total: 2,
        success: 0,
        failed: 2,
        alreadySaved: 0,
      }),
    ).toBe(true);
  });

  it("成功あり・対象0・未定義は false", () => {
    expect(
      shouldShowUploadAllEvidenceFailedError({
        total: 2,
        success: 1,
        failed: 1,
        alreadySaved: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowUploadAllEvidenceFailedError({
        total: 0,
        success: 0,
        failed: 0,
        alreadySaved: 0,
      }),
    ).toBe(false);
    expect(shouldShowUploadAllEvidenceFailedError(undefined)).toBe(false);
  });
});

describe("shouldAutoLookupArchive", () => {
  it("Parse 成功時は他ソースが空でも true", () => {
    expect(
      shouldAutoLookupArchive({
        hasParsedSuccess: true,
        hasSessionStatus: false,
        hasUploadSuccess: false,
        hasArchiveSuccess: false,
      }),
    ).toBe(true);
  });

  it("すべて未成立なら false", () => {
    expect(
      shouldAutoLookupArchive({
        hasParsedSuccess: false,
        hasSessionStatus: false,
        hasUploadSuccess: false,
        hasArchiveSuccess: false,
      }),
    ).toBe(false);
  });
});

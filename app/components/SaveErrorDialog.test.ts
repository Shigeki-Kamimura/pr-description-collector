/**
 * SaveErrorDialog の表示用エラーメッセージ整形テスト
 *
 * このファイルを用意した理由:
 * - partial-write エラー時に内部状態（rollback詳細）をUIへ露出しない契約を固定するため。
 *
 * このファイルが使われる場面:
 * - `npm run test` 実行時に、エラーメッセージの情報漏えい回帰を検知するとき。
 */
import { describe, expect, it } from "vitest";
import { formatErrorDialogTitle, formatPartialWriteErrorMessage } from "./SaveErrorDialog";

describe("formatPartialWriteErrorMessage", () => {
  it("partial-write では常に定型メッセージを返す", () => {
    const message = formatPartialWriteErrorMessage(
      "OneDrive API error (500): write failed | partial-write: description.md saved then archive.json failed; rollback=failed (permission denied)",
    );
    expect(message).toBe(
      "保存中にエラーが発生しました。一部のファイルが保存されたまま残っている可能性があります。再実行する前に OneDrive 上の保存先フォルダーを確認し、重複や不要なファイルを整理してください。解決しない場合は、再認証または時間をおいて再実行してください。",
    );
  });

  it("partial-write でなければ null を返す", () => {
    expect(formatPartialWriteErrorMessage("OneDrive API error (401)")).toBeNull();
  });
});

describe("formatErrorDialogTitle", () => {
  it("保存文脈は保存ラベルを返す", () => {
    expect(formatErrorDialogTitle("save", false)).toBe("エラーが発生しました（保存）");
  });

  it("画像文脈は表示ラベルを返す", () => {
    expect(formatErrorDialogTitle("image", false)).toBe("エラーが発生しました（表示）");
  });

  it("表示文脈は表示ラベルを返す", () => {
    expect(formatErrorDialogTitle("display", false)).toBe("エラーが発生しました（表示）");
  });

  it("認証エラー時は文脈より認証ラベルを優先する", () => {
    expect(formatErrorDialogTitle("save", true)).toBe("エラーが発生しました（認証）");
    expect(formatErrorDialogTitle("image", true)).toBe("エラーが発生しました（認証）");
  });
});

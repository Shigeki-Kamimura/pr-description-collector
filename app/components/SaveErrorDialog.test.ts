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
import { formatPartialWriteErrorMessage } from "./SaveErrorDialog";

describe("formatPartialWriteErrorMessage", () => {
  it("partial-write では常に定型メッセージを返す", () => {
    const message = formatPartialWriteErrorMessage(
      "OneDrive API error (500): write failed | partial-write: description.md saved then archive.json failed; rollback=failed (permission denied)",
    );
    expect(message).toBe(
      "保存に失敗しました。再試行してください。解決しない場合は管理者にお問い合わせください。",
    );
  });

  it("partial-write でなければ null を返す", () => {
    expect(formatPartialWriteErrorMessage("OneDrive API error (401)")).toBeNull();
  });
});

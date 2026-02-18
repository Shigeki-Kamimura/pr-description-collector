/**
 * PR参照バリデーションのテスト
 *
 * このファイルを用意した理由:
 * - フロント/バックエンド共通ルールの入力検証契約を固定し、片側だけ通る回帰を防ぐため。
 *
 * このファイルが使われる場面:
 * - `npm run test` 実行時に、`validatePrRefFields` と `validatePrRefInput` の整合性を確認するとき。
 */
import { describe, expect, it } from "vitest";
import { validatePrRefFields, validatePrRefInput } from "./validation";

describe("validation", () => {
  it("validatePrRefFields: 正常系を受け入れる", () => {
    expect(validatePrRefFields("octocat", "hello-world.repo", "123")).toEqual({
      ok: true,
      owner: "octocat",
      repo: "hello-world.repo",
      prNumber: 123,
    });
  });

  it("validatePrRefFields: 不正owner/repo/prNumberを拒否する", () => {
    expect(validatePrRefFields("-octocat", "hello world", "0")).toEqual({
      ok: false,
      error: "owner/repo/prNumber を正しく指定してください",
    });
  });

  it("validatePrRefInput: FormData経由でも同一ルールを適用する", () => {
    const formData = new FormData();
    formData.set("owner", "  octocat  ");
    formData.set("repo", "  hello-world  ");
    formData.set("prNumber", "  10 ");

    expect(validatePrRefInput(formData)).toEqual({
      ok: true,
      owner: "octocat",
      repo: "hello-world",
      prNumber: 10,
    });
  });
});

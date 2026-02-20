/**
 * pr-ref ユーティリティのテスト
 *
 * このファイルを用意した理由:
 * - PR参照の正規化・一致判定の不変条件を固定し、UI側の保存可否判定の回帰を防ぐため。
 *
 * このファイルが使われる場面:
 * - `npm run test` 実行時に、入力の空白除去と参照一致判定が期待通りかを検証するとき。
 */
import { describe, expect, it } from "vitest";
import { isSamePrRef, normalizePrRef } from "./pr-ref";

describe("pr-ref", () => {
  it("normalizePrRef: 各入力の前後空白を除去する", () => {
    expect(
      normalizePrRef({
        owner: "  octocat  ",
        repo: "  Hello-World ",
        prNumber: "  123 ",
      }),
    ).toEqual({
      owner: "octocat",
      repo: "Hello-World",
      prNumber: "123",
    });
  });

  it("isSamePrRef: 完全一致のとき true を返す", () => {
    expect(
      isSamePrRef(
        { owner: "octocat", repo: "Hello-World", prNumber: "123" },
        { owner: "octocat", repo: "Hello-World", prNumber: "123" },
      ),
    ).toBe(true);
  });

  it("isSamePrRef: いずれかが不一致のとき false を返す", () => {
    expect(
      isSamePrRef(
        { owner: "octocat", repo: "Hello-World", prNumber: "123" },
        { owner: "octocat", repo: "Hello-World", prNumber: "124" },
      ),
    ).toBe(false);
  });
});

/**
 * evidence-url ユーティリティのテスト
 *
 * このファイルを用意した理由:
 * - URL正規化の契約（クエリ順・ハッシュ・末尾スラッシュ処理）を固定し、表示回帰を防ぐため。
 *
 * このファイルが使われる場面:
 * - `npm run test` 実行時に、保存済み画像照合のキー生成が壊れていないか確認するとき。
 */
import { describe, expect, it } from "vitest";
import { normalizeEvidenceSourceUrl } from "./evidence-url";

describe("normalizeEvidenceSourceUrl", () => {
  it("クエリ順序・ハッシュ・末尾スラッシュの揺れを正規化する", () => {
    const a = normalizeEvidenceSourceUrl("https://example.com/path/?b=2&a=1#frag");
    const b = normalizeEvidenceSourceUrl("https://example.com/path?a=1&b=2");
    expect(a).toBe(b);
  });

  it("URLでない文字列はtrimして返す", () => {
    expect(normalizeEvidenceSourceUrl("  not-a-url  ")).toBe("not-a-url");
  });
});

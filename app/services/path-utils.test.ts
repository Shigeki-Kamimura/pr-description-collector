/**
 * パスユーティリティのテスト
 *
 * このファイルを用意した理由:
 * - upload/archive で共有する slugifyForPath の契約を固定し、将来の乖離を防ぐため。
 *
 * このファイルが使われる場面:
 * - `npm run test` で OneDrive 保存先フォルダ名の生成規則を検証するとき。
 */
import { describe, expect, it } from "vitest";
import { slugifyForPath } from "./path-utils";

describe("slugifyForPath", () => {
  it("禁止文字を除去し、空白をハイフンに正規化する", () => {
    expect(slugifyForPath('  A<B>:C"D/E\\F|G?H*I  ')).toBe("ABCDEFGHI");
    expect(slugifyForPath("hello   world")).toBe("hello-world");
  });

  it("日本語を保持しつつ先頭末尾の記号を除去する", () => {
    expect(slugifyForPath("  .-  仕様レビュー 日本語  -. ")).toBe("仕様レビュー-日本語");
  });

  it("長すぎる値はコードポイントとUTF-8バイト上限で切り詰める", () => {
    const longAscii = "a".repeat(120);
    const longJa = "あ".repeat(100);
    expect(slugifyForPath(longAscii).length).toBe(80);
    expect(slugifyForPath(longJa).length).toBeLessThanOrEqual(53);
  });
});

/**
 * エビデンス画像トークン署名ユーティリティのテスト
 *
 * このファイルを用意した理由:
 * - 画像パスとトークンの結び付け契約を固定し、改ざん耐性の回帰を防ぐため。
 *
 * このファイルが使われる場面:
 * - `npm run test` 実行時に、署名/検証ロジックの正常系・異常系を確認するとき。
 */
import { describe, expect, it, vi } from "vitest";
import {
  isEvidenceImageTokenFormat,
  signEvidenceImagePath,
  verifyEvidenceImagePathToken,
} from "./evidence-image-token.server";

describe("evidence-image-token.server", () => {
  it("期限内の token は検証成功する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00.000Z"));
    const path = "project/repo/PullRequests/PR10-Test/imgs/a.png";
    const token = signEvidenceImagePath(path);

    expect(isEvidenceImageTokenFormat(token)).toBe(true);
    expect(verifyEvidenceImagePathToken(path, token)).toBe(true);
    vi.useRealTimers();
  });

  it("同じ path は同じ token で検証成功する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00.000Z"));
    const path = "project/repo/PullRequests/PR10-Test/imgs/a.png";
    const token = signEvidenceImagePath(path);

    expect(isEvidenceImageTokenFormat(token)).toBe(true);
    expect(verifyEvidenceImagePathToken(path, token)).toBe(true);
    vi.useRealTimers();
  });

  it("別 path の token は検証失敗する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00.000Z"));
    const path = "project/repo/PullRequests/PR10-Test/imgs/a.png";
    const otherPath = "project/repo/PullRequests/PR10-Test/imgs/b.png";
    const token = signEvidenceImagePath(path);

    expect(verifyEvidenceImagePathToken(otherPath, token)).toBe(false);
    vi.useRealTimers();
  });

  it("token の有効期限が切れた場合は検証失敗する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00.000Z"));
    const path = "project/repo/PullRequests/PR10-Test/imgs/a.png";
    const token = signEvidenceImagePath(path);
    vi.setSystemTime(new Date("2026-02-25T00:11:00.000Z"));

    expect(verifyEvidenceImagePathToken(path, token)).toBe(false);
    vi.useRealTimers();
  });

  it("expiresAt を改ざんした token は検証失敗する", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-25T00:00:00.000Z"));
    const path = "project/repo/PullRequests/PR10-Test/imgs/a.png";
    const token = signEvidenceImagePath(path);
    const [macHex] = token.split(":");
    const tamperedToken = `${macHex}:9999999999999`;

    expect(verifyEvidenceImagePathToken(path, tamperedToken)).toBe(false);
    vi.useRealTimers();
  });

  it("token フォーマットが不正な場合は検証失敗する", () => {
    const path = "project/repo/PullRequests/PR10-Test/imgs/a.png";

    expect(isEvidenceImageTokenFormat("not-token")).toBe(false);
    expect(verifyEvidenceImagePathToken(path, "not-token")).toBe(false);
  });
});

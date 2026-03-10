import { describe, expect, it } from "vitest";
import { extractOneDriveError, isOneDriveAuthLikeError, resolveOneDriveAuthStatus } from "./onedrive-errors.server";

describe("onedrive-errors", () => {
  it("extractOneDriveError は message 末尾の request-id メタを除去する", () => {
    const raw =
      "OneDrive API error (401) [code=InvalidAuthenticationToken]: token expired " +
      "[request-id=abc client-request-id=def date=2026-01-01T00:00:00Z]";

    expect(extractOneDriveError(raw)).toEqual({
      code: "InvalidAuthenticationToken",
      message: "token expired",
    });
  });

  it("extractOneDriveError は通常メッセージを保持する", () => {
    const raw = "OneDrive API error (500) [code=generalException]: transient backend error";

    expect(extractOneDriveError(raw)).toEqual({
      code: "generalException",
      message: "transient backend error",
    });
  });

  it("isOneDriveAuthLikeError は 401 エラー文言を認証エラーとして扱う", () => {
    const raw = "OneDrive API error (401) [code=InvalidAuthenticationToken]: token expired";
    expect(isOneDriveAuthLikeError(raw)).toBe(true);
  });

  it("isOneDriveAuthLikeError は token crypto エラーを認証エラー扱いしない", () => {
    const raw = "OneDrive token crypto encrypt failed: cipher failed";
    expect(isOneDriveAuthLikeError(raw)).toBe(false);
  });

  it("resolveOneDriveAuthStatus は code=AccessDenied を 403 に正規化する", () => {
    const raw = "OneDrive API error (401) [code=AccessDenied]: forbidden";
    expect(resolveOneDriveAuthStatus(raw, "AccessDenied")).toBe(403);
  });

  it("resolveOneDriveAuthStatus は code 不在でも (403) を優先して 403 にする", () => {
    const raw = "OneDrive API error (403): forbidden";
    expect(resolveOneDriveAuthStatus(raw, undefined)).toBe(403);
  });

  it("resolveOneDriveAuthStatus は 403 根拠がない場合 401 にする", () => {
    const raw = "OneDrive API error (401): token expired";
    expect(resolveOneDriveAuthStatus(raw, undefined)).toBe(401);
  });
});

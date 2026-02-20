import { describe, expect, it } from "vitest";
import { extractOneDriveError } from "./onedrive-errors.server";

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
});

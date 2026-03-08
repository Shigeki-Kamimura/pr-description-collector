/**
 * このファイルを用意した理由:
 * - OneDrive監査ログのマスキング契約が壊れないように回帰防止するため。
 *
 * このファイルが使われる場面:
 * - ログpayload生成時に token/secret などの機微情報が `[REDACTED]` へ置換されるか検証するとき。
 */
import { describe, expect, it } from "vitest";
import { buildOneDriveAuditErrorPayload, sanitizeAuditPayload } from "./onedrive-audit-log.server";

describe("onedrive-audit-log", () => {
  it("機微なtoken/secret情報を [REDACTED] に置換する", () => {
    const payload = buildOneDriveAuditErrorPayload({
      event: "onedrive.test",
      route: "api/onedrive/test",
      failureType: "test",
      error: new Error(
        "OneDrive API error (401) [code=InvalidAuthenticationToken]: token=abc123 access_token=xyz secret=foo",
      ),
    });

    expect(payload.message).not.toContain("abc123");
    expect(payload.message).not.toContain("xyz");
    expect(payload.message).not.toContain("foo");
    expect(payload.message).toContain("[REDACTED]");
  });

  it("payload key名が機微情報の場合は値をマスクする", () => {
    const payload = sanitizeAuditPayload({
      token: "plain-token",
      refreshToken: "refresh-token",
      nested: {
        authorization: "Bearer abc.def.ghi",
      },
    });

    expect(payload.token).toBe("[REDACTED]");
    expect(payload.refreshToken).toBe("[REDACTED]");
    expect(payload.nested).toEqual({ authorization: "[REDACTED]" });
  });
});

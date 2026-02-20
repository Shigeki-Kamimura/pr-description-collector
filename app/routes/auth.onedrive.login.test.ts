import { describe, expect, it } from "vitest";
import { loader } from "./auth.onedrive.login";

describe("auth.onedrive.login loader", () => {
  it("HTTPアクセスは400で拒否する", async () => {
    const request = new Request("http://localhost:5173/auth/onedrive/login");

    const response = await loader({ request });
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(body).toContain("Secure Cookie is unavailable on HTTP");
  });
});

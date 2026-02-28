import { describe, expect, it } from "vitest";
import { loader } from "./api.health";

describe("api.health loader", () => {
  it("依存なしで healthy を返す", async () => {
    const request = new Request("http://localhost/api/health");
    const response = await loader({ request } as never);
    const body = (await response.json()) as {
      ok: boolean;
      status: string;
    };

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      status: "healthy",
    });
  });
});

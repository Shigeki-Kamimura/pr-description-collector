import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "./_index";
import { createGitHubServiceFromEnv } from "../services/github.server";
import { verifyCsrfToken } from "../services/csrf.server";
import { validatePrRefInput } from "../services/validation";

vi.mock("../services/github.server", () => ({
  createGitHubServiceFromEnv: vi.fn(),
}));

vi.mock("../services/csrf.server", () => ({
  ensureCsrfToken: vi.fn(),
  verifyCsrfToken: vi.fn(),
}));

vi.mock("../services/validation", () => ({
  validatePrRefInput: vi.fn(),
  validatePrRefFields: vi.fn(),
  INVALID_PR_REF_ERROR: "owner/repo/prNumber を正しく指定してください",
}));

function buildRequest(): Request {
  const form = new FormData();
  form.set("owner", "octocat");
  form.set("repo", "hello-world");
  form.set("prNumber", "123");
  form.set("csrfToken", "csrf-token");
  return new Request("http://localhost/", { method: "POST", body: form });
}

describe("_index action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validatePrRefInput).mockReturnValue({
      ok: true,
      owner: "octocat",
      repo: "hello-world",
      prNumber: 123,
    });
  });

  it("CSRF不一致時は403で拒否し、GitHub呼び出しを行わない", async () => {
    vi.mocked(verifyCsrfToken).mockResolvedValue(false);

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; error: string };

    expect(response.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("不正なリクエストです。ページを再読み込みして再試行してください。");
    expect(createGitHubServiceFromEnv).not.toHaveBeenCalled();
  });
});

/**
 * /api/collect ルートのテスト
 *
 * このファイルを用意した理由:
 * - GitHub 5xx / ネットワークエラー時に、要件どおりの定型メッセージを返す契約を固定するため。
 *
 * このファイルが使われる場面:
 * - `npm run test` 実行時に、`/api/collect` のエラーハンドリング回帰を検知するとき。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { action } from "./api.collect";
import { createGitHubServiceFromEnv } from "../services/github.server";
import { validatePrRefInput } from "../services/validation";

vi.mock("../services/github.server", () => ({
  createGitHubServiceFromEnv: vi.fn(),
}));

vi.mock("../services/validation", () => ({
  validatePrRefInput: vi.fn(),
}));

type MockGitHubService = {
  getPullRequest: ReturnType<typeof vi.fn>;
  getPullRequestReviews: ReturnType<typeof vi.fn>;
};

function buildRequest(): Request {
  const form = new FormData();
  form.set("owner", "octocat");
  form.set("repo", "hello-world");
  form.set("prNumber", "123");
  return new Request("http://localhost/api/collect", { method: "POST", body: form });
}

describe("api.collect action", () => {
  let github: MockGitHubService;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validatePrRefInput).mockReturnValue({
      ok: true,
      owner: "octocat",
      repo: "hello-world",
      prNumber: 123,
    });
    github = {
      getPullRequest: vi.fn(),
      getPullRequestReviews: vi.fn(),
    };
    vi.mocked(createGitHubServiceFromEnv).mockResolvedValue(github as never);
  });

  it("GitHub 5xx は定型メッセージを返す", async () => {
    const githubError = Object.assign(new Error("github internal"), { status: 500 });
    github.getPullRequest.mockRejectedValue(githubError);

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; error: string };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("GitHub API への接続に失敗しました。しばらくしてから再実行してください。");
  });

  it("GitHub ネットワークエラー（statusなし）も定型メッセージを返す", async () => {
    github.getPullRequest.mockRejectedValue(new Error("socket hang up"));

    const response = await action({ request: buildRequest() } as never);
    const body = (await response.json()) as { ok: false; error: string };

    expect(response.status).toBe(502);
    expect(body.ok).toBe(false);
    expect(body.error).toBe("GitHub API への接続に失敗しました。しばらくしてから再実行してください。");
  });
});

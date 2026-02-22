import { beforeEach, describe, expect, it, vi } from "vitest";

const octokitInstances: Array<{
  rest: { pulls: { get: ReturnType<typeof vi.fn>; listReviews: ReturnType<typeof vi.fn> } };
}> = [];

vi.mock("octokit", () => ({
  Octokit: class {
    rest = {
      pulls: {
        get: vi.fn(),
        listReviews: vi.fn(),
      },
    };
    constructor() {
      octokitInstances.push(this as never);
    }
  },
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth: vi.fn(),
}));

describe("github service pagination", () => {
  beforeEach(() => {
    octokitInstances.length = 0;
    vi.clearAllMocks();
    vi.resetModules();
    vi.useRealTimers();
    delete process.env.GITHUB_REQUEST_TIMEOUT_SECONDS;
    delete process.env.GITHUB_REQUEST_TIMEOUT_MS;
  });

  it("getPullRequestReviews は 100件超のとき次ページも取得する", async () => {
    const { createGitHubService } = await import("./github.server");
    const service = createGitHubService({ token: "token" });
    const octokit = octokitInstances[0];
    const listReviews = octokit.rest.pulls.listReviews;

    const page1 = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      state: "COMMENTED",
      submitted_at: `2026-01-01T00:${String(index % 60).padStart(2, "0")}:00Z`,
      user: { login: `user-${index + 1}` },
      html_url: `https://example.com/r/${index + 1}`,
    }));
    const page2 = [
      {
        id: 999,
        state: "APPROVED",
        submitted_at: "2026-01-02T00:00:00Z",
        user: { login: "reviewer-final" },
        html_url: "https://example.com/r/999",
      },
    ];
    listReviews.mockResolvedValueOnce({ data: page1 }).mockResolvedValueOnce({ data: page2 });

    const reviews = await service.getPullRequestReviews({
      repo: { owner: "octocat", name: "hello-world" },
      number: 123,
    });

    expect(reviews).toHaveLength(101);
    expect(reviews[100]).toMatchObject({
      id: "999",
      state: "APPROVED",
      userLogin: "reviewer-final",
    });
    expect(listReviews).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ per_page: 100, page: 1 }),
    );
    expect(listReviews).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ per_page: 100, page: 2 }),
    );
  });

  it("GitHub API応答がない場合はタイムアウトで失敗する", async () => {
    vi.useFakeTimers();
    const { createGitHubService } = await import("./github.server");
    const service = createGitHubService({ token: "token" });
    const octokit = octokitInstances[0];
    octokit.rest.pulls.get.mockReturnValue(new Promise(() => {}) as never);

    const requestPromise = service.getPullRequest({
      repo: { owner: "octocat", name: "hello-world" },
      number: 123,
    });

    const assertion = expect(requestPromise).rejects.toThrow(/timed out after \d+ms/);
    await vi.advanceTimersByTimeAsync(180_000);
    await assertion;
  });

  it("GITHUB_REQUEST_TIMEOUT_SECONDS を優先して秒として解釈する", async () => {
    vi.useFakeTimers();
    process.env.GITHUB_REQUEST_TIMEOUT_SECONDS = "1";
    process.env.GITHUB_REQUEST_TIMEOUT_MS = "30000";
    const { createGitHubService } = await import("./github.server");
    const service = createGitHubService({ token: "token" });
    const octokit = octokitInstances[0];
    octokit.rest.pulls.get.mockReturnValue(new Promise(() => {}) as never);

    const requestPromise = service.getPullRequest({
      repo: { owner: "octocat", name: "hello-world" },
      number: 123,
    });

    const assertion = expect(requestPromise).rejects.toThrow("timed out after 1000ms");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("旧キー GITHUB_REQUEST_TIMEOUT_MS も秒として解釈する", async () => {
    vi.useFakeTimers();
    process.env.GITHUB_REQUEST_TIMEOUT_MS = "1";
    const { createGitHubService } = await import("./github.server");
    const service = createGitHubService({ token: "token" });
    const octokit = octokitInstances[0];
    octokit.rest.pulls.get.mockReturnValue(new Promise(() => {}) as never);

    const requestPromise = service.getPullRequest({
      repo: { owner: "octocat", name: "hello-world" },
      number: 123,
    });

    const assertion = expect(requestPromise).rejects.toThrow("timed out after 1000ms");
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });
});

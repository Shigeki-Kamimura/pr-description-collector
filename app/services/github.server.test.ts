import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubService } from "./github.server";

const octokitInstances: Array<{ rest: { pulls: { listReviews: ReturnType<typeof vi.fn> } } }> = [];

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
  });

  it("getPullRequestReviews は 100件超のとき次ページも取得する", async () => {
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
});

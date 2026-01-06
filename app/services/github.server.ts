/**
 * GitHub連携（サーバー側）
 *
 * 役割:
 * - GitHub REST APIから PR 情報（本文Markdown含む）を取得する
 * - 取得結果をアプリ内の最小限の型（PullRequest）へ正規化する
 *
 * 設計意図:
 * - 現時点は依存を増やさず fetch ベースで最小実装
 * - 後続Issueで Octokit へ差し替えても、呼び出し側は GitHubService の境界を維持できる
 */

export type GitHubAuth = {
  /** GitHub Personal Access Token または GITHUB_TOKEN */
  token: string;
};

export type GitHubRepoRef = {
  owner: string;
  name: string;
};

export type PullRequestRef = {
  repo: GitHubRepoRef;
  number: number;
};

export type PullRequest = {
  id: string;
  number: number;
  title: string;
  body: string; // PR本文（Markdown）
  url: string;
};

export interface GitHubService {
  /** PR本文（Markdown）を取得 */
  getPullRequestDescription(ref: PullRequestRef): Promise<string>;
  /** PRメタ情報を取得 */
  getPullRequest(ref: PullRequestRef): Promise<PullRequest>;
}

type GitHubPullResponse = {
  // GitHub APIのレスポンス（必要なフィールドのみ抜粋）
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
};

function assertOk(response: Response, url: string) {
  // GitHub APIから非2xxが返った場合に早期に例外化する。
  // 呼び出し側は try/catch でUI表示向けにハンドリングする。
  if (response.ok) return;
  const message = `GitHub API error: ${response.status} ${response.statusText} (${url})`;
  throw new Error(message);
}

async function githubGet<T>(auth: GitHubAuth, path: string): Promise<T> {
  // REST API（api.github.com）へのGET共通処理。
  // - Authorization: サーバー側のトークン（PATやGITHUB_TOKEN）をBearerとして付与
  // - Accept: REST v3の推奨メディアタイプ
  // - X-GitHub-Api-Version: 互換性のため固定
  const url = `https://api.github.com${path}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${auth.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pr-description-collector",
    },
  });
  assertOk(response, url);
  return (await response.json()) as T;
}

/**
 * fetchベースの最小実装。
 * 将来的にOctokitへ差し替える前提で、型境界をここに閉じ込める。
 */
export function createGitHubService(auth: GitHubAuth): GitHubService {
  return {
    async getPullRequest(ref: PullRequestRef): Promise<PullRequest> {
      // PR取得: GET /repos/{owner}/{repo}/pulls/{pull_number}
      // 返ってくるbodyはnullの可能性があるため空文字に正規化して返す。
      const data = await githubGet<GitHubPullResponse>(
        auth,
        `/repos/${ref.repo.owner}/${ref.repo.name}/pulls/${ref.number}`,
      );

      return {
        // アプリ内ではIDを文字列で扱う（将来DB保存等で扱いやすくするため）
        id: String(data.id),
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        url: data.html_url,
      };
    },

    async getPullRequestDescription(ref: PullRequestRef): Promise<string> {
      // 現時点ではPRの取得結果から本文のみを返す薄いラッパー。
      // 呼び出し側が「本文だけ欲しい」ケースを明示できる。
      const pr = await this.getPullRequest(ref);
      return pr.body;
    },
  };
}

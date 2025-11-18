// GitHub サービスの型定義のみ（実装なし）

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

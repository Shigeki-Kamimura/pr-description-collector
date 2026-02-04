/**
 * GitHub連携（サーバー側）
 *
 * 役割:
 * - GitHub REST APIから PR 情報（本文Markdown含む）とレビュー情報を取得する
 * - 取得結果をアプリ内の最小限の型へ正規化する
 *
 * 設計意図:
 * - Issue #2 の要件に合わせ、Octokitで実装する（公式クライアント）
 * - 呼び出し側は GitHubService 境界に依存し、後続の拡張（項目追加等）を容易にする
 */

import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";

export type GitHubAuth = {
  /** GitHub Personal Access Token または GITHUB_TOKEN */
  token: string;
};

export type GitHubAppAuth = {
  /** GitHub App の App ID */
  appId: number;
  /** GitHub App の Installation ID */
  installationId: number;
  /** GitHub App の Private Key（PEM）。改行込みの文字列 */
  privateKey: string;
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

export type PullRequestReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export type PullRequestReview = {
  id: string;
  state: PullRequestReviewState;
  submittedAt: string | null;
  userLogin: string | null;
  url: string | null;
};

export interface GitHubService {
  /** PR本文（Markdown）を取得 */
  getPullRequestDescription(ref: PullRequestRef): Promise<string>;
  /** PRメタ情報を取得 */
  getPullRequest(ref: PullRequestRef): Promise<PullRequest>;
  /** PRレビュー一覧を取得 */
  getPullRequestReviews(ref: PullRequestRef): Promise<PullRequestReview[]>;
  /** APPROVED が存在するか（最新APPROVEDがあるか） */
  hasApprovedReview(ref: PullRequestRef): Promise<boolean>;
}

function toReviewState(value: unknown): PullRequestReviewState {
  // Octokitの型を直接外に漏らさないために、値をホワイトリストで正規化する。
  switch (value) {
    case "APPROVED":
    case "CHANGES_REQUESTED":
    case "COMMENTED":
    case "DISMISSED":
    case "PENDING":
      return value;
    default:
      return "COMMENTED";
  }
}

function createOctokit(auth: GitHubAuth) {
  // 現時点はトークン認証のみ（後続でAuth Code Flow等に拡張予定）
  return new Octokit({ auth: auth.token });
}

async function createOctokitFromGitHubApp(auth: GitHubAppAuth) {
  // GitHub App の Installation Token を都度発行して Octokit を作る。
  // private repo 対応や権限最小化の観点で、PATより運用しやすい。
  const appAuth = createAppAuth({
    appId: auth.appId,
    privateKey: auth.privateKey,
    installationId: auth.installationId,
  });
  const installation = await appAuth({ type: "installation" });
  return new Octokit({ auth: installation.token });
}

/**
 * 環境変数から GitHub への認証手段を決める。
 * 優先順位: PAT/Token（GITHUB_TOKEN/GITHUB_PAT）→ GitHub App（GITHUB_APP_*）
 */
export async function createGitHubServiceFromEnv(): Promise<GitHubService> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? null;
  if (token) return createGitHubService({ token });

  const appIdRaw = process.env.GITHUB_APP_ID ?? "";
  const installationIdRaw = process.env.GITHUB_APP_INSTALLATION_ID ?? "";
  const privateKeyRaw = process.env.GITHUB_APP_PRIVATE_KEY ?? "";

  const appId = Number(appIdRaw);
  const installationId = Number(installationIdRaw);
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  if (!Number.isFinite(appId) || !Number.isFinite(installationId) || !privateKey) {
    throw new Error(
      "GitHub認証情報が未設定です。GITHUB_TOKEN/GITHUB_PAT または GITHUB_APP_ID/GITHUB_APP_INSTALLATION_ID/GITHUB_APP_PRIVATE_KEY を設定してください",
    );
  }

  const octokit = await createOctokitFromGitHubApp({ appId, installationId, privateKey });
  return createGitHubServiceWithOctokit(octokit);
}

function createGitHubServiceWithOctokit(octokit: Octokit): GitHubService {
  // Octokit生成手段（PAT/GitHub Appなど）を差し替え可能にするための薄いラッパー。
  return {
    async getPullRequest(ref: PullRequestRef): Promise<PullRequest> {
      const { data } = await octokit.rest.pulls.get({
        owner: ref.repo.owner,
        repo: ref.repo.name,
        pull_number: ref.number,
      });

      return {
        id: String(data.id),
        number: data.number,
        title: data.title,
        body: data.body ?? "",
        url: data.html_url ?? "",
      };
    },

    async getPullRequestDescription(ref: PullRequestRef): Promise<string> {
      const pr = await this.getPullRequest(ref);
      return pr.body;
    },

    async getPullRequestReviews(ref: PullRequestRef): Promise<PullRequestReview[]> {
      const { data } = await octokit.rest.pulls.listReviews({
        owner: ref.repo.owner,
        repo: ref.repo.name,
        pull_number: ref.number,
        per_page: 100,
      });

      return data.map((review) => ({
        id: String(review.id),
        state: toReviewState(review.state),
        submittedAt: review.submitted_at ?? null,
        userLogin: review.user?.login ?? null,
        url: review.html_url ?? null,
      }));
    },

    async hasApprovedReview(ref: PullRequestRef): Promise<boolean> {
      const reviews = await this.getPullRequestReviews(ref);
      return reviews.some((r) => r.state === "APPROVED");
    },
  };
}

export function createGitHubService(auth: GitHubAuth): GitHubService {
  const octokit = createOctokit(auth);
  return createGitHubServiceWithOctokit(octokit);
}

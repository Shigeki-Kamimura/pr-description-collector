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


// Octokit本体とGitHub App認証をインポート
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
// GitHubリポジトリの参照情報
export type GitHubRepoRef = {
  owner: string;
  name: string;
};
// PR参照情報
export type PullRequestRef = {
  repo: GitHubRepoRef;
  number: number;
};

// PR情報の型
export type PullRequest = {
  id: string; // string化したID
  number: number; // PR番号
  title: string;// PRタイトル
  body: string; // PR本文（Markdown）
  url: string; // PRのHTML URL
  authorLogin: string | null; // PR作成者
  mergedByLogin: string | null; // PRをマージしたユーザー
};

export type PullRequestReviewState = "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED" | "PENDING";

export type PullRequestReview = {
  id: string; // ID
  state: PullRequestReviewState; // レビュー状態
  submittedAt: string | null; // 提出日時（ISO 8601文字列）
  userLogin: string | null; // レビュアーのユーザーログイン名
  url: string | null; // レビューのHTML URL
};

export interface GitHubService {
  /** PR本文（Markdown）を取得 */
  getPullRequestDescription(ref: PullRequestRef): Promise<string>;
  /** PRメタ情報を取得 */
  getPullRequest(ref: PullRequestRef): Promise<PullRequest>;
  /** PRレビュー一覧を取得 */
  getPullRequestReviews(ref: PullRequestRef): Promise<PullRequestReview[]>;
  /** APPROVED レビューが1件以上存在するか（簡易判定。最新状態の厳密な判定ではない） */
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
  const getPullRequest = async (ref: PullRequestRef): Promise<PullRequest> => {
    const { data } = await octokit.rest.pulls.get({
      owner: ref.repo.owner,
      repo: ref.repo.name,
      pull_number: ref.number,
    });
    // Octokitの型をアプリ内型に変換して返す
    return {
      id: String(data.id),
      number: data.number,
      title: data.title,
      body: data.body ?? "",
      url: data.html_url ?? "",
      authorLogin: data.user?.login ?? null,
      mergedByLogin: data.merged_by?.login ?? null,
    };
  };

  return {
    getPullRequest, // PRメタ情報を取得
    // PR本文（Markdown）を取得
    async getPullRequestDescription(ref: PullRequestRef): Promise<string> {
      const pr = await getPullRequest(ref);
      return pr.body;
    },
    // PRレビュー一覧を取得
    async getPullRequestReviews(ref: PullRequestRef): Promise<PullRequestReview[]> {
      const { data } = await octokit.rest.pulls.listReviews({
        owner: ref.repo.owner,
        repo: ref.repo.name,
        pull_number: ref.number,
        per_page: 100,
      });
      // Octokitの型をアプリ内型に変換して返す
      return data.map((review) => ({
        id: String(review.id),
        state: toReviewState(review.state),
        submittedAt: review.submitted_at ?? null,
        userLogin: review.user?.login ?? null,
        url: review.html_url ?? null,
      }));
    },
    // APPROVED レビューが1件以上存在するか（簡易判定。最新状態の厳密な判定ではない）
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

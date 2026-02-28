/**
 * GitHub連携（サーバー側）
 *
 * このファイルを用意した理由:
 * - GitHub REST API 呼び出しと認証方式の違いを、アプリ本体から隠蔽するため。
 *
 * このファイルが使われる場面:
 * - PR本文、PRメタ情報、レビュー一覧を取得するとき。
 */


// Octokit本体とGitHub App認証をインポート
import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";

const DEFAULT_GITHUB_REQUEST_TIMEOUT_SECONDS = 180;
// 秒指定の環境変数を、内部で扱うミリ秒へ安全に変換する。
function parseTimeoutSecondsToMs(value: string | undefined, fallbackMs: number): number {
  const parsedSeconds = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsedSeconds) || parsedSeconds <= 0) return fallbackMs;
  return parsedSeconds * 1000;
}

const GITHUB_REQUEST_TIMEOUT_MS = parseTimeoutSecondsToMs(
  process.env.GITHUB_REQUEST_TIMEOUT_SECONDS,
  DEFAULT_GITHUB_REQUEST_TIMEOUT_SECONDS * 1000,
);

// Octokit 自体に統一タイムアウトを付けづらいため、各API呼び出しを外から包む。
function withRequestTimeout<T>(
  buildPromise: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // AbortControllerを使ってリクエストにタイムアウトを設定する。
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
      reject(new Error(`GitHub API request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    buildPromise(controller.signal).then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}

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

// GitHub の review state は将来増える可能性があるため、画面側では既知値だけに正規化する。
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

// PAT / GITHUB_TOKEN 用の最小生成関数。認証方式の差し替え点を1か所に集約する。
function createOctokit(auth: GitHubAuth) {
  // 現時点はトークン認証のみ（後続でAuth Code Flow等に拡張予定）
  return new Octokit({ auth: auth.token });
}

// GitHub App 認証は Installation Token 発行を含むため、非同期で Octokit を作る。
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

  const appId = Number.parseInt(appIdRaw, 10);
  const installationId = Number.parseInt(installationIdRaw, 10);
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  const isValidAppAuth =
    Number.isSafeInteger(appId) &&
    appId > 0 &&
    Number.isSafeInteger(installationId) &&
    installationId > 0 &&
    privateKey.length > 0;

  if (!isValidAppAuth) {
    throw new Error(
      "GitHub認証情報が未設定です。GITHUB_TOKEN/GITHUB_PAT または GITHUB_APP_ID/GITHUB_APP_INSTALLATION_ID/GITHUB_APP_PRIVATE_KEY を設定してください",
    );
  }

  const octokit = await createOctokitFromGitHubApp({ appId, installationId, privateKey });
  return createGitHubServiceWithOctokit(octokit);
}

// 呼び出し側が Octokit に直接依存しないよう、アプリ専用の GitHubService に閉じ込める。
function createGitHubServiceWithOctokit(octokit: Octokit): GitHubService {
  // Octokit生成手段（PAT/GitHub Appなど）を差し替え可能にするための薄いラッパー。
  const getPullRequest = async (ref: PullRequestRef): Promise<PullRequest> => {
    const { data } = await withRequestTimeout(
      (signal) =>
        octokit.rest.pulls.get({
          owner: ref.repo.owner,
          repo: ref.repo.name,
          pull_number: ref.number,
          request: { signal },
        }),
      GITHUB_REQUEST_TIMEOUT_MS,
    );
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
      const perPage = 100;
      const data = [];
      // GitHub APIは1回のリクエストで最大100件までしか取得できないため、ページネーションを処理する。
      for (let page = 1; ; page += 1) {
        const response = await withRequestTimeout(
          (signal) =>
            octokit.rest.pulls.listReviews({
              owner: ref.repo.owner,
              repo: ref.repo.name,
              pull_number: ref.number,
              per_page: perPage,
              page,
              request: { signal },
            }),
          GITHUB_REQUEST_TIMEOUT_MS,
        );
        data.push(...response.data);
        if (response.data.length < perPage) break;
      }
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

// PAT 認証の public entry point。テストや将来の明示注入で使う。
export function createGitHubService(auth: GitHubAuth): GitHubService {
  const octokit = createOctokit(auth);
  return createGitHubServiceWithOctokit(octokit);
}

/**
 * /api/collect
 *
 * このルートはUIから呼び出されるサーバー側API（action）として動作し、
 * 指定された owner/repo/prNumber のPR情報をGitHub REST APIから取得して
 * 「PR本文（Markdown）」および PRメタ/レビュー情報を返す。
 *
 * 目的:
 * - UI側の「Get Description」ボタンから、PR本文をtextareaへ流し込む
 * - 後続のチェックリスト抽出/Markdown→HTML化/OneDrive保存の入力元を統一する
 * - レビュー（APPROVED有無など）をJSONで確認できるようにする
 *
 * 注意:
 * - 認証は現時点ではサーバー環境変数のトークン（GITHUB_TOKEN または GITHUB_PAT）前提
 * - GitHubへのアクセス実装は services/github.server.ts（Octokit）に閉じ込める
 * - 画像DLやupload sessionは別Issueで対応（本ルートでは扱わない）
 */
import type { ActionFunctionArgs } from "react-router";

import {
  createGitHubServiceFromEnv,
  type PullRequest,
  type PullRequestReview,
  type PullRequestRef,
} from "../services/github.server";
import { validatePrRefInput } from "../services/validation";
import { getHttpStatus } from "../services/http-status";

export type ApiCollectResponse =
  | {
      ok: true;
      pullRequest: PullRequest;
      reviews: PullRequestReview[];
      /** レビュー一覧に APPROVED が1件以上含まれるか（簡易判定） */
      hasApproved: boolean;
      description: string;
    }
  | {
      ok: false;
      error: string;
    };

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const validation = validatePrRefInput(formData);
  if (!validation.ok) {
    return Response.json(
      {
        ok: false,
        error: validation.error,
      } satisfies ApiCollectResponse,
      { status: 400 },
    );
  }

  try {
    const github = await createGitHubServiceFromEnv();
    const ref: PullRequestRef = {
      repo: { owner: validation.owner, name: validation.repo },
      number: validation.prNumber,
    };
    const pullRequest = await github.getPullRequest(ref);
    const reviews = await github.getPullRequestReviews(ref);

    const hasApproved = reviews.some((r) => r.state === "APPROVED");

    return Response.json(
      {
        ok: true,
        pullRequest,
        reviews,
        hasApproved,
        description: pullRequest.body,
      } satisfies ApiCollectResponse,
      { status: 200 },
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const status = getHttpStatus(error);
    if (status !== null) {
      switch (status) {
        case 401:
          return Response.json(
            { ok: false, error: "GitHub認証に失敗しました。トークンを確認してください。", },
            { status: 401 },
          );
        case 403:
          return Response.json(
            { ok: false, error: "アクセスが拒否されました。権限またはレート制限を確認してください。", },
            { status: 403 },
          );
        case 404:
          return Response.json(
            { ok: false, error: "指定されたPRが見つかりません。owner/repo/prNumber を確認してください。", },
            { status: 404 },
          );
        case 429:
          return Response.json(
            { ok: false, error: "レート制限のため一時的に失敗しました。しばらくしてから再実行してください。", },
            { status: 429 },
          );
        default:
          return Response.json(
            { ok: false, error: `GitHub APIエラー (${status}): ${errorMessage}`, },
            { status: 502 },
          );
      }
    }
    return Response.json(
      { ok: false, error: errorMessage } satisfies ApiCollectResponse,
      { status: 502 },
    );
  }
}

/**
 * /api/collect
 *
 * このファイルを用意した理由:
 * - 画面から GitHub PR 情報を取得する処理を UI から分離するため。
 *
 * このファイルが使われる場面:
 * - Get Description 押下時に、PR本文とレビュー情報をまとめて取得するとき。
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

// action は取得専用 API。PR本文とレビュー情報をまとめて返し、画面側の表示入力を統一する。
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
            { ok: false, error: "GitHub API への接続に失敗しました。しばらくしてから再実行してください。", },
            { status: 502 },
          );
      }
    }
    return Response.json(
      { ok: false, error: "GitHub API への接続に失敗しました。しばらくしてから再実行してください。" } satisfies ApiCollectResponse,
      { status: 502 },
    );
  }
}

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
// OctokitのRequestErrorを使ってエラー判定
import { RequestError } from "@octokit/request-error";

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
  // フォームPOSTで受け取る（fetcher.submit からの送信もここに来る）
  const formData = await request.formData();
  const owner = String(formData.get("owner") ?? "").trim();
  const repo = String(formData.get("repo") ?? "").trim();
  const prNumberRaw = String(formData.get("prNumber") ?? "").trim();
  const prNumber = Number(prNumberRaw);

  // 入力値の最低限バリデーション（不正入力は400で返す）
  // owner/repo/prNumber はサーバー側で再取得するため必須
  // prNumber は整数であることを確認
  // 負の数や0はありえないので除外
  if (!owner || !repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    return Response.json(
      {
        ok: false,
        error: "owner/repo/prNumber を正しく指定してください",
      } satisfies ApiCollectResponse,
      { status: 400 },
    );
  }

  try {
    // GitHub APIへアクセスし、PRメタ＋本文（Markdown）＋レビューを取得
    const github = await createGitHubServiceFromEnv();
    const ref: PullRequestRef = { repo: { owner, name: repo }, number: prNumber };
    const pullRequest = await github.getPullRequest(ref);
    const reviews = await github.getPullRequestReviews(ref);

    // UI/後続処理向けの簡易フラグ（厳密な「最新APPROVED」判定は後で強化してもよい）
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
    // Octokit の RequestError からステータスコード別にユーザー向けメッセージを返す
    if (error instanceof RequestError) {
      const status = error.status;
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
        default:
          return Response.json(
            { ok: false, error: `GitHub APIエラー (${status}): ${error.message}`, },
            { status: 502 },
          );
      }
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json(
      { ok: false, error: message } satisfies ApiCollectResponse,
      { status: 502 },
    );
  }
}

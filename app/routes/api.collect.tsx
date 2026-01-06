/**
 * /api/collect
 *
 * このルートはUIから呼び出されるサーバー側API（action）として動作し、
 * 指定された owner/repo/prNumber のPR情報をGitHub REST APIから取得して
 * 「PR本文（Markdown）」を返す。
 *
 * 目的:
 * - UI側の「Get Description」ボタンから、PR本文をtextareaへ流し込む
 * - 後続のチェックリスト抽出/Markdown→HTML化/OneDrive保存の入力元を統一する
 *
 * 注意:
 * - 認証は現時点ではサーバー環境変数のトークン（GITHUB_TOKEN または GITHUB_PAT）前提
 * - 画像DLやupload sessionは別Issueで対応（本ルートでは扱わない）
 */
import type { ActionFunctionArgs } from "react-router";

import {
  createGitHubService,
  type PullRequest,
  type PullRequestRef,
} from "../services/github.server";

export type ApiCollectResponse =
  | {
      ok: true;
      pullRequest: PullRequest;
      description: string;
    }
  | {
      ok: false;
      error: string;
    };

function getGitHubToken(): string | null {
  // まずはローカル/CIで動かしやすいように、2つの変数名を許容する。
  return process.env.GITHUB_TOKEN ?? process.env.GITHUB_PAT ?? null;
}

export async function action({ request }: ActionFunctionArgs) {
  // フォームPOSTで受け取る（fetcher.submit からの送信もここに来る）
  const formData = await request.formData();
  const owner = String(formData.get("owner") ?? "").trim();
  const repo = String(formData.get("repo") ?? "").trim();
  const prNumberRaw = String(formData.get("prNumber") ?? "").trim();
  const prNumber = Number(prNumberRaw);

  // 入力値の最低限バリデーション（不正入力は400で返す）
  if (!owner || !repo || !Number.isFinite(prNumber) || prNumber <= 0) {
    return Response.json(
      {
        ok: false,
        error: "owner/repo/prNumber を正しく指定してください",
      } satisfies ApiCollectResponse,
      { status: 400 },
    );
  }

  const token = getGitHubToken();
  // サーバー側設定ミスは500扱い（クライアント入力起因ではない）
  if (!token) {
    return Response.json(
      {
        ok: false,
        error:
          "サーバ環境変数 GITHUB_TOKEN (または GITHUB_PAT) が未設定です",
      } satisfies ApiCollectResponse,
      { status: 500 },
    );
  }

  try {
    // GitHub APIへアクセスし、PRメタ＋本文（Markdown）を取得
    const github = createGitHubService({ token });
    const ref: PullRequestRef = { repo: { owner, name: repo }, number: prNumber };
    const pullRequest = await github.getPullRequest(ref);

    return Response.json(
      {
        ok: true,
        pullRequest,
        description: pullRequest.body,
      } satisfies ApiCollectResponse,
      { status: 200 },
    );
  } catch (error) {
    // upstream（GitHub）由来の失敗は502で返す（UI側で表示しやすいように文字列化）
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json(
      { ok: false, error: message } satisfies ApiCollectResponse,
      { status: 502 },
    );
  }
}

/**
 * /api/onedrive/upload
 *
 * 目的:
 * - GitHubからPR情報（description/reviews）を取得し、OneDriveへ保存する
 * - 画像を含むHTML生成は後続（まず保存先＝OneDriveを確立する）
 *
 * 前提:
 * - 開発段階では ONEDRIVE_ACCESS_TOKEN を env で与える（/me/drive 配下を利用）
 */
import type { ActionFunctionArgs } from "react-router";

import {
  createGitHubServiceFromEnv,
  type PullRequestRef,
} from "../services/github.server";
import { createOneDriveServiceFromEnv } from "../services/onedrive.server";

export type ApiOneDriveUploadResponse =
  | {
      ok: true;
      folderPath: string;
      uploaded: {
        descriptionMd: { name: string; webUrl: string };
        pullRequestJson: { name: string; webUrl: string };
        reviewsJson: { name: string; webUrl: string };
      };
    }
  | {
      ok: false;
      error: string;
    };

function toInt(value: string) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : NaN;
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const owner = String(formData.get("owner") ?? "").trim();
  const repo = String(formData.get("repo") ?? "").trim();
  const prNumber = toInt(String(formData.get("prNumber") ?? "").trim());

  if (!owner || !repo || !Number.isFinite(prNumber) || prNumber <= 0) {
    return Response.json(
      { ok: false, error: "owner/repo/prNumber を正しく指定してください" } satisfies ApiOneDriveUploadResponse,
      { status: 400 },
    );
  }

  try {
    const github = await createGitHubServiceFromEnv();
    const onedrive = createOneDriveServiceFromEnv();

    const ref: PullRequestRef = {
      repo: { owner, name: repo },
      number: prNumber,
    };

    const pullRequest = await github.getPullRequest(ref);
    const reviews = await github.getPullRequestReviews(ref);

    const baseFolder = (process.env.ONEDRIVE_BASE_FOLDER ?? "pr-description-collector").replace(
      /^\/+|\/+$/g,
      "",
    );
    const folderPath = `${baseFolder}/${owner}/${repo}/pr-${prNumber}`;

    const descriptionMd = await onedrive.saveText(
      `${folderPath}/description.md`,
      pullRequest.body,
    );

    const pullRequestJson = await onedrive.saveText(
      `${folderPath}/pull-request.json`,
      JSON.stringify(pullRequest, null, 2),
    );

    const reviewsJson = await onedrive.saveText(
      `${folderPath}/reviews.json`,
      JSON.stringify(reviews, null, 2),
    );

    return Response.json(
      {
        ok: true,
        folderPath,
        uploaded: {
          descriptionMd: { name: descriptionMd.name, webUrl: descriptionMd.webUrl },
          pullRequestJson: { name: pullRequestJson.name, webUrl: pullRequestJson.webUrl },
          reviewsJson: { name: reviewsJson.name, webUrl: reviewsJson.webUrl },
        },
      } satisfies ApiOneDriveUploadResponse,
      { status: 200 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return Response.json(
      { ok: false, error: message } satisfies ApiOneDriveUploadResponse,
      { status: 502 },
    );
  }
}

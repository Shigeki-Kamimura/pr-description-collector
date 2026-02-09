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
import { parseChecklist } from "../services/checklist";

export type ApiOneDriveUploadResponse =
  | {
      ok: true;
      folderPath: string;
      uploaded: {
        descriptionMd: { name: string; webUrl: string };
        archiveJson: { name: string; webUrl: string };
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
    // サービス初期化
    const github = await createGitHubServiceFromEnv();
    const onedrive = createOneDriveServiceFromEnv();
    // PR情報取得
    const ref: PullRequestRef = {
      repo: { owner, name: repo },
      number: prNumber,
    };
    // PR情報・レビュー情報取得
    const pullRequest = await github.getPullRequest(ref);
    const reviews = await github.getPullRequestReviews(ref);
    const checklist = parseChecklist(pullRequest.body);

    // 承認レビューのうち最新のものを取得
    const approvedReviews = reviews
      .filter((review) => review.state === "APPROVED" && review.submittedAt)
      .sort((a, b) => (a.submittedAt! < b.submittedAt! ? 1 : -1));
    const latestApproved = approvedReviews[0] ?? null;
    const reviewer = latestApproved?.userLogin ?? "UNKNOWN";

    // OneDriveへ保存
    const now = new Date();
    const archivedAtUtc = now.toISOString();
    const archivedAt = formatIsoWithOffset(now, 9 * 60);
    // フォルダパス例: pr-description-collector/owner/repo/pr-123
    const baseFolder = (process.env.ONEDRIVE_BASE_FOLDER ?? "pr-description-collector").replace(
      /^\/+|\/+$/g,
      "",
    );
    const folderPath = `${baseFolder}/${owner}/${repo}/pr-${prNumber}`;
    // description.md 保存
    const descriptionMd = await onedrive.saveText(
      `${folderPath}/description.md`,
      pullRequest.body,
    );
    // archive.json 保存
    const archiveJson = await onedrive.saveText(
      `${folderPath}/archive.json`,
      JSON.stringify(
        {
          prNumber: pullRequest.number,
          prTitle: pullRequest.title,
          repoOwner: owner,
          repoName: repo,
          prUrl: pullRequest.url,
          prAuthor: pullRequest.authorLogin ?? "UNKNOWN",
          reviewer,
          archivedBy: reviewer,
          body: pullRequest.body,
          archivedAt,
          archivedAtUtc,
          checklist: {
            items: checklist.items,
          },
          evidenceImages: [],
        },
        null,
        2,
      ),
    );
    // レスポンス返却
    return Response.json(
      {
        ok: true,
        folderPath,
        uploaded: {
          descriptionMd: { name: descriptionMd.name, webUrl: descriptionMd.webUrl },
          archiveJson: { name: archiveJson.name, webUrl: archiveJson.webUrl },
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
// 指定した分のオフセットを持つISO 8601形式の文字列を生成する
function formatIsoWithOffset(date: Date, offsetMinutes: number): string {
  const offsetMs = offsetMinutes * 60 * 1000;
  const local = new Date(date.getTime() + offsetMs);
  const year = local.getUTCFullYear();
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  const hours = String(local.getUTCHours()).padStart(2, "0");
  const minutes = String(local.getUTCMinutes()).padStart(2, "0");
  const seconds = String(local.getUTCSeconds()).padStart(2, "0");
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(abs / 60)).padStart(2, "0");
  const offsetMins = String(abs % 60).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetMins}`;
}

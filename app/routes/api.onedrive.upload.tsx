/**
 * /api/onedrive/upload
 *
 * 目的:
 * - GitHubからPR情報（description/reviews）を取得し、OneDriveへ保存する
 * - 画像を含むHTML生成は後続（まず保存先＝OneDriveを確立する）
 *
 * 前提:
 * - OneDrive アクセストークンは OAuth セッションを優先し、開発用途で env 指定も許可する
 */
import type { ActionFunctionArgs } from "react-router";
// GitHub関連のサービス
import {
  createGitHubServiceFromEnv,
  type PullRequestRef,
} from "../services/github.server";
// OneDrive関連のサービスとエラー処理ユーティリティ
import { extractOneDriveError, isOneDriveAuthLikeError } from "../services/onedrive-errors.server";
// OneDriveサービスの生成ユーティリティ
import { createOneDriveServiceFromEnv } from "../services/onedrive.server";
// チェックリスト解析ユーティリティ
import { parseChecklist } from "../services/checklist";

// OneDriveのファイル名やフォルダ名に使えるように文字列を整形するユーティリティ
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
      errorCode?: string;
      errorMessage?: string;
    };
// 文字列を整数に変換（失敗時は NaN）
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
    const onedrive = await createOneDriveServiceFromEnv(request);
    // 要件: 保存前に OneDrive セッション有効性を確認する
    await onedrive.getDriveInfo();
    // PR情報取得
    const ref: PullRequestRef = {
      repo: { owner, name: repo },
      number: prNumber,
    };
    // PR情報・レビュー情報取得
    const pullRequest = await github.getPullRequest(ref);
    const reviews = await github.getPullRequestReviews(ref);
    // OneDriveの現在ユーザーは取得失敗しても保存処理を継続する
    let currentUser: { userPrincipalName: string | null; displayName: string | null } | null = null;
    try {
      currentUser = await onedrive.getCurrentUser();
    } catch {
      currentUser = null;
    }
    // チェックリスト解析
    const checklist = parseChecklist(pullRequest.body);

    // 承認レビューのうち最新のものを取得
    const approvedReviews = reviews
      .filter((review) => review.state === "APPROVED" && review.submittedAt)
      .sort((a, b) => (a.submittedAt! < b.submittedAt! ? 1 : -1));
    const latestApproved = approvedReviews[0] ?? null;
    const reviewer = latestApproved?.userLogin ?? "UNKNOWN";
    // アーカイブ実行者
    const archivedBy =
      currentUser?.userPrincipalName ??
      currentUser?.displayName ??
      "UNKNOWN";

    // OneDriveへ保存
    const now = new Date();
    const archivedAtUtc = now.toISOString();
    const archivedAt = formatIsoWithOffset(now, 9 * 60);
    // フォルダパス例: pr-description-collector/owner/repo/pr-123
    const baseFolder = (process.env.ONEDRIVE_BASE_FOLDER ?? "project").replace(
      /^\/+|\/+$/g,
      "",
    );
    const workFolder = (process.env.ONEDRIVE_WORK_FOLDER ?? "").replace(
      /^\/+|\/+$/g,
      "",
    );
    // フォルダ名に使うタイトルを整形
    const rawSafeTitle = slugifyForPath(pullRequest.title);
    // フォルダパスを組み立てる、安全なタイトルが空文字列になる場合は "untitled" を使う
    const safeTitle = rawSafeTitle.length > 0 ? rawSafeTitle : "untitled";
    const rootPrefix = workFolder ? `${workFolder}/${baseFolder}` : baseFolder;
    const folderPath = `${rootPrefix}/${repo}/PullRequests/PR${prNumber}-${safeTitle}`;
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
          prNumber: pullRequest.number, // 
          prTitle: pullRequest.title,
          repoOwner: owner,
          repoName: repo,
          prUrl: pullRequest.url,
          prAuthor: pullRequest.authorLogin ?? "UNKNOWN", // PR作成者
          mergedBy: pullRequest.mergedByLogin ?? "UNKNOWN", // PRマージ実行者
          reviewer, // 承認レビュー実行者（最新）
          archivedBy, // アーカイブ実行者（OneDriveユーザー）
          body: pullRequest.body, // PR本文（Markdown）
          archivedAt, // アーカイブ日時（JST ISO 8601）
          archivedAtUtc, // アーカイブ日時（UTC ISO 8601）
          checklist: {
            items: checklist.items, // チェックリスト項目一覧
          },
          evidenceImages: [], // 画像情報一覧（未対応）
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
    // エラーハンドリング
    const rawMessage = error instanceof Error ? error.message : "Unknown error";
    const parsed = extractOneDriveError(rawMessage);
    let message = rawMessage;
    if (isOneDriveAuthLikeError(rawMessage)) {
      // OneDrive の認証エラーと推測される場合、わかりやすいメッセージに変換
      const hasDetail = Boolean(parsed.code || parsed.message);
      message = hasDetail
        ? `${parsed.code ?? "UNKNOWN"}: ${parsed.message ?? rawMessage}`
        : "OneDrive 認証が切れています。再認証してから保存をやり直してください。";
    }
    const status = isOneDriveAuthLikeError(rawMessage) ? 401 : 502;
    return Response.json(
      {
        ok: false,
        error: message,
        errorCode: parsed.code,
        errorMessage: parsed.message ?? rawMessage,
      } satisfies ApiOneDriveUploadResponse,
      { status },
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

function slugifyForPath(value: string): string {
  const normalized = value
    .normalize("NFKD")
    // OneDrive/Windowsで使えない文字のみ除外し、日本語などは保持する
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "");

  return normalized.slice(0, 80);
}

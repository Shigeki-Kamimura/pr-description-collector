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
import {
  createGitHubServiceFromEnv,
  type PullRequestRef,
} from "../services/github.server";
import { extractOneDriveError, isOneDriveAuthLikeError } from "../services/onedrive-errors.server";
import { createOneDriveServiceFromEnv } from "../services/onedrive.server";
import { parseChecklist } from "../services/checklist";
import { validatePrRefInput } from "../services/validation";

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
      isAuthError: boolean;
      errorCode?: string;
      errorMessage?: string;
    };
export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const validation = validatePrRefInput(formData);
  if (!validation.ok) {
    return Response.json(
      { ok: false, error: validation.error, isAuthError: false } satisfies ApiOneDriveUploadResponse,
      { status: 400 },
    );
  }
  const { owner, repo, prNumber } = validation;

  try {
    const github = await createGitHubServiceFromEnv();
    const onedrive = await createOneDriveServiceFromEnv(request);
    // 保存処理の前に OneDrive セッションの有効性を検証する。
    await onedrive.getDriveInfo();
    const ref: PullRequestRef = {
      repo: { owner, name: repo },
      number: prNumber,
    };
    const pullRequest = await github.getPullRequest(ref);
    const reviews = await github.getPullRequestReviews(ref);
    // 保存実行者を特定できない場合は監査要件のため保存を中止する。
    const currentUser = await onedrive.getCurrentUser();
    const checklist = parseChecklist(pullRequest.body);

    const approvedReviews = reviews
      .filter((review) => review.state === "APPROVED" && review.submittedAt)
      .sort((a, b) => (a.submittedAt! < b.submittedAt! ? 1 : -1));
    const latestApproved = approvedReviews[0] ?? null;
    const reviewer = latestApproved?.userLogin ?? "UNKNOWN";
    const archivedBy = currentUser.userPrincipalName ?? currentUser.displayName;
    if (!archivedBy) {
      throw new Error("OneDrive current user could not be identified.");
    }

    const now = new Date();
    const archivedAtUtc = now.toISOString();
    const archivedAt = formatIsoForJst(now);
    const baseFolder = (process.env.ONEDRIVE_BASE_FOLDER ?? "project").replace(
      /^\/+|\/+$/g,
      "",
    );
    const workFolder = (process.env.ONEDRIVE_WORK_FOLDER ?? "").replace(
      /^\/+|\/+$/g,
      "",
    );
    const rawSafeTitle = slugifyForPath(pullRequest.title);
    const safeTitle = rawSafeTitle.length > 0 ? rawSafeTitle : "untitled";
    const rootPrefix = workFolder ? `${workFolder}/${baseFolder}` : baseFolder;
    const folderPath = `${rootPrefix}/${repo}/PullRequests/PR${prNumber}-${safeTitle}`;
    const descriptionPath = `${folderPath}/description.md`;
    const archivePath = `${folderPath}/archive.json`;
    // description.md と archive.json の両方を保存する。description.md の保存に成功してから archive.json の保存に失敗した場合は、description.md を削除するロールバックを試みる。
    let descriptionMd: { name: string; webUrl: string } | null = null;
    let archiveJson: { name: string; webUrl: string } | null = null;
    let rollbackAttempted = false;
    let rollbackSucceeded = false;
    let rollbackFailureReason = "unknown";

    try {
      descriptionMd = await onedrive.saveText(descriptionPath, pullRequest.body);
      archiveJson = await onedrive.saveText(
        archivePath,
        JSON.stringify(
          {
            prNumber: pullRequest.number,
            prTitle: pullRequest.title,
            repoOwner: owner,
            repoName: repo,
            prUrl: pullRequest.url,
            prAuthor: pullRequest.authorLogin ?? "UNKNOWN",
            mergedBy: pullRequest.mergedByLogin ?? "UNKNOWN",
            reviewer,
            archivedBy,
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
    } catch (writeError) {
      if (descriptionMd && !archiveJson) {
        rollbackAttempted = true;
        try {
          await onedrive.deleteItem(descriptionPath);
          rollbackSucceeded = true;
        } catch (rollbackError) {
          rollbackSucceeded = false;
          const reason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
          rollbackFailureReason = reason.trim() || "unknown";
        }
      }

      const raw = writeError instanceof Error ? writeError.message : String(writeError);
      if (!descriptionMd) {
        // description.md 保存前の失敗は部分書き込みではないため、そのまま返す。
        throw new Error(raw);
      }
      const rollbackInfo = rollbackAttempted
        ? rollbackSucceeded
          ? "rollback=ok"
          : `rollback=failed (${rollbackFailureReason})`
        : "rollback=not-attempted";
      throw new Error(`${raw} | partial-write: description.md saved then archive.json failed; ${rollbackInfo}`);
    }
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
    const rawMessage = error instanceof Error ? error.message : "Unknown error";
    const parsed = extractOneDriveError(rawMessage);
    let message = rawMessage;
    if (isOneDriveAuthLikeError(rawMessage)) {
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
        isAuthError: status === 401,
        errorCode: parsed.code,
        errorMessage: parsed.message ?? rawMessage,
      } satisfies ApiOneDriveUploadResponse,
      { status },
    );
  }
}

function formatIsoForJst(date: Date): string {
  const offsetMinutes = 9 * 60;
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
    .normalize("NFC")
    // OneDrive/Windowsで禁止される文字だけ除去し、日本語は保持する。
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "");

  // サロゲートペアを壊さないよう、コードポイント単位で上限を適用する。
  return Array.from(normalized).slice(0, 80).join("");
}

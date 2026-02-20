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
import { getHttpStatus } from "../services/http-status";
import { extractOneDriveError, isOneDriveAuthLikeError } from "../services/onedrive-errors.server";
import { createOneDriveServiceFromEnv } from "../services/onedrive.server";
import { parseChecklist } from "../services/checklist";
import { verifyCsrfToken } from "../services/csrf.server";
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
  // CSRFトークンの検証。失敗した場合は 403 を返す。
  if (!(await verifyCsrfToken(request, formData))) {
    return Response.json(
      {
        ok: false,
        error: "不正なリクエストです。ページを再読み込みして再試行してください。",
        isAuthError: false,
      } satisfies ApiOneDriveUploadResponse,
      { status: 403 },
    );
  }
  const { owner, repo, prNumber } = validation;

  let failureDomain: "github" | "onedrive" | "internal" = "github";
  try {
    const github = await createGitHubServiceFromEnv();
    failureDomain = "onedrive";
    const onedrive = await createOneDriveServiceFromEnv(request);
    // 保存処理の前に OneDrive セッションの有効性を検証する。
    await onedrive.getDriveInfo();
    failureDomain = "github";
    const ref: PullRequestRef = {
      repo: { owner, name: repo },
      number: prNumber,
    };
    const pullRequest = await github.getPullRequest(ref);
    const reviews = await github.getPullRequestReviews(ref);
    failureDomain = "onedrive";
    // 保存実行者を特定できない場合は監査要件のため保存を中止する。
    const currentUser = await onedrive.getCurrentUser();
    failureDomain = "internal";
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
    // ロールバックの試行状況と結果を記録する変数。これにより、部分的に成功した状態で失敗した場合の状況を詳細にログに残せるようになる。
    let rollbackAttempted = false;
    let rollbackSucceeded = false;
    let rollbackFailureReason = "unknown";
    let rollbackFolderCleanup = "not-attempted";

    try {
      failureDomain = "onedrive"; // 明示的に失敗ドメインを切り替える。ここで失敗した場合はロールバックの必要はないため、以降は failureDomain を変更しない。
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
          // description.md の削除後、空フォルダが残らないようにフォルダ削除も試みる。
          try {
            await onedrive.deleteItem(folderPath);
            rollbackFolderCleanup = "ok";
          } catch (folderCleanupError) {
            const reason = folderCleanupError instanceof Error ? folderCleanupError.message : String(folderCleanupError);
            rollbackFolderCleanup = `failed (${reason.trim() || "unknown"})`;
            console.warn("OneDrive rollback folder cleanup skipped.", {
              folderPath,
              reason,
            });
          }
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
          ? `rollback=ok folderCleanup=${rollbackFolderCleanup}`
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
    if (failureDomain === "github") {
      const status = getHttpStatus(error);
      if (status !== null) {
        switch (status) {
          case 401:
            return Response.json(
              {
                ok: false,
                error: "GitHub認証に失敗しました。トークンを確認してください。",
                isAuthError: false,
              } satisfies ApiOneDriveUploadResponse,
              { status: 401 },
            );
          case 403:
            return Response.json(
              {
                ok: false,
                error: "アクセスが拒否されました。権限またはレート制限を確認してください。",
                isAuthError: false,
              } satisfies ApiOneDriveUploadResponse,
              { status: 403 },
            );
          case 404:
            return Response.json(
              {
                ok: false,
                error: "指定されたPRが見つかりません。owner/repo/prNumber を確認してください。",
                isAuthError: false,
              } satisfies ApiOneDriveUploadResponse,
              { status: 404 },
            );
          case 429:
            return Response.json(
              {
                ok: false,
                error: "レート制限のため一時的に失敗しました。しばらくしてから再実行してください。",
                isAuthError: false,
              } satisfies ApiOneDriveUploadResponse,
              { status: 429 },
            );
          default:
            return Response.json(
              {
                ok: false,
                error: "GitHub API への接続に失敗しました。しばらくしてから再実行してください。",
                isAuthError: false,
              } satisfies ApiOneDriveUploadResponse,
              { status: 502 },
            );
        }
      }
      return Response.json(
        {
          ok: false,
          error: "GitHub API への接続に失敗しました。しばらくしてから再実行してください。",
          isAuthError: false,
        } satisfies ApiOneDriveUploadResponse,
        { status: 502 },
      );
    }
    // OneDrive への保存処理中のエラーは、認証エラーかどうかに関わらず基本的には 502 として返す。ただし、認証エラーと判断できる場合は 401 とする。
    if (failureDomain === "internal") {
      return Response.json(
        {
          ok: false,
          error: "保存処理中に予期しないエラーが発生しました。しばらくしてから再実行してください。",
          isAuthError: false,
        } satisfies ApiOneDriveUploadResponse,
        { status: 500 },
      );
    }

    const parsed = extractOneDriveError(rawMessage);
    const isAuthLike = isOneDriveAuthLikeError(rawMessage); // エラーメッセージの解析結果が認証エラーっぽいかどうか。これが true の場合は 401、そうでない場合は 502 として返す。
    const hasDetail = Boolean(parsed.code || parsed.message); // 解析結果にエラーコードや詳細メッセージが含まれているかどうか。これが true の場合は、認証エラーっぽい場合でも詳細を含むメッセージを返す。そうでない場合は、認証エラーっぽくても定型の再認証メッセージを返す。
    const message = isAuthLike
      ? hasDetail
        ? `${parsed.code ?? "UNKNOWN"}: ${parsed.message ?? rawMessage}`
        : "OneDrive 認証が切れています。再認証してから保存をやり直してください。"
      : "OneDrive への保存に失敗しました。しばらくしてから再実行してください。";
    // 認証エラーっぽい場合でも、エラーコードや詳細メッセージがない場合は定型の再認証メッセージを返す。これにより、OneDrive API のエラーレスポンスの形式が変わったり、予期しないエラーが発生した場合でも、ユーザーには再認証が必要な可能性があることを伝えることができる。
    if (!isAuthLike) {
      console.error("OneDrive upload failed.", {
        message: rawMessage,
        code: parsed.code,
        detail: parsed.message,
      });
    }
    const status = isAuthLike ? 401 : 502;
    return Response.json(
      {
        ok: false,
        error: message,
        isAuthError: status === 401,
        errorCode: isAuthLike ? parsed.code : undefined,
        errorMessage: isAuthLike ? parsed.message ?? rawMessage : undefined,
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

  // サロゲートペアを壊さず、かつ過度に長いマルチバイト文字列を避けるため、
  // コードポイント数と UTF-8 バイト長の両方で上限を適用する。
  const maxCodePoints = 80;
  const maxUtf8Bytes = 160;
  const encoder = new TextEncoder();
  let result = "";
  let codePointCount = 0;
  let utf8ByteCount = 0;

  for (const char of normalized) {
    const charBytes = encoder.encode(char).length;
    if (codePointCount + 1 > maxCodePoints || utf8ByteCount + charBytes > maxUtf8Bytes) {
      break;
    }
    result += char;
    codePointCount += 1;
    utf8ByteCount += charBytes;
  }

  return result;
}

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
import { createOneDriveServiceFromEnv, OneDriveApiError } from "../services/onedrive.server";
// CSRFトークンの検証ユーティリティ
import {
  buildImageBaseName,
  downloadImageWithRetry,
  extractUniqueImageUrls,
} from "../services/evidence-images.server";
import { parseChecklist } from "../services/checklist";
import { verifyCsrfToken } from "../services/csrf.server";
import { normalizeEvidenceSourceUrl } from "../services/evidence-url";
import { validatePrRefInput } from "../services/validation";
import { signEvidenceImagePath } from "../services/evidence-image-token.server";

// ルートハンドラーとビジネスロジックを分離するため、OneDrive への保存処理の詳細は services/evidence-images.server.ts に委譲する。
export type ApiOneDriveUploadResponse =
  | {
      ok: true;
      folderPath: string;
      evidenceImages: {
        total: number;
        success: number;
        failed: number;
        alreadySaved: number;
      };
      evidenceImageRecords: Array<{
        sourceUrl: string;
        status: EvidenceImageStatus;
        fileName: string | null;
        onedrivePath: string | null;
        imageAccessToken: string | null;
        webUrl: string | null;
        errorReason: string | null;
      }>;
      alreadySavedFiles: {
        descriptionMd: boolean;
        archiveJson: boolean;
      };
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
    
/* OneDrive への保存処理中のエラーは、認証エラーかどうかに関わらず基本的には 502 として返す。
// ただし、認証エラーと判断できる場合は 401 とする。
// これにより、UI側で認証エラーとそれ以外のエラーを区別して適切なユーザーメッセージを表示できるようになる。
*/
type EvidenceImageStatus = "success" | "failed";

type EvidenceImageRecord = {
  sourceUrl: string;
  status: EvidenceImageStatus;
  fileName: string | null;
  onedrivePath: string | null;
  webUrl: string | null;
  errorReason: string | null;
};
const DEFAULT_EVIDENCE_IMAGE_MAX_KB = 10 * 1024;
const BYTES_PER_KILOBYTE = 1024;
const DEFAULT_EVIDENCE_IMAGE_MAX_COUNT = 20; // 画像の枚数が多すぎると保存処理が重くなったり、OneDrive の容量を圧迫したりする可能性があるため、上限を設ける。
const MAX_ONEDRIVE_SIMPLE_UPLOAD_BYTES = 250 * 1024 * 1024; // Microsoft Graph 単純アップロードの上限
const MAX_CONSECUTIVE_ONEDRIVE_SAVE_FAILURES = 2;
const MAX_SAVE_CONFLICT_RETRIES = 20;
const ONEDRIVE_SAVE_FAILED_REASON = "ONEDRIVE_SAVE_FAILED";
const ONEDRIVE_SAVE_SKIPPED_REASON = "ONEDRIVE_SAVE_SKIPPED_AFTER_CONSECUTIVE_FAILURE";
const IMAGE_LIMIT_EXCEEDED_REMAINING_REASON = "IMAGE_LIMIT_EXCEEDED_REMAINING";
const ALREADY_SAVED_REASON = "ALREADY_SAVED";

/*
/ 画像URL抽出の重複排除、ダウンロード再試行、拡張子補完の契約を固定するため、
/ これらの機能を提供する関数は services/evidence-images.server.ts に切り出している。
/ これにより、これらの機能の実装を変更する際に、ルートハンドラーのコードを変更せずに済むようになる。 
*/
class EvidenceImagesSaveError extends Error {
  readonly savedImagePaths: string[];

  constructor(message: string, savedImagePaths: string[]) {
    super(message);
    this.name = "EvidenceImagesSaveError";
    this.savedImagePaths = savedImagePaths;
  }
}

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
    failureDomain = "onedrive";

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
    const descriptionMdAlreadySaved = (await onedrive.getItem(descriptionPath)) !== null;
    const archiveJsonAlreadySaved = (await onedrive.getItem(archivePath)) !== null;
    const alreadySavedEvidenceBySource = await loadExistingEvidenceBySource(
      onedrive,
      archivePath,
      archiveJsonAlreadySaved,
    );
    // description.md と archive.json の両方を保存する。description.md の保存に成功してから archive.json の保存に失敗した場合は、description.md を削除するロールバックを試みる。
    let descriptionMd: { name: string; webUrl: string } | null = null;
    let archiveJson: { name: string; webUrl: string } | null = null;
    let evidenceImages: EvidenceImageRecord[] = [];
    // ロールバックの試行状況と結果を記録する変数。これにより、部分的に成功した状態で失敗した場合の状況を詳細にログに残せるようになる。
    let rollbackAttempted = false;
    let rollbackSucceeded = false;
    let rollbackFailureReason = "unknown";
    let rollbackEvidenceCleanup = "not-attempted";
    let rollbackFolderCleanup = "not-attempted";

    try {
      failureDomain = "onedrive"; // 明示的に失敗ドメインを切り替える。ここで失敗した場合はロールバックの必要はないため、以降は failureDomain を変更しない。
      descriptionMd = await onedrive.saveText(descriptionPath, pullRequest.body);
      evidenceImages = await saveEvidenceImages({
        markdown: pullRequest.body,
        folderPath,
        onedrive,
        alreadySavedEvidenceBySource,
      });
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
            evidenceImages,
          },
          null,
          2,
        ),
      );
    } catch (writeError) {
      if (descriptionMd && !archiveJson) {
        rollbackAttempted = true;
        const savedEvidencePaths = collectSavedEvidencePaths(evidenceImages, writeError);
        // description.md は保存されたがarchive.jsonの保存に失敗した場合、description.mdとevidenceImagesで保存された画像を削除するロールバックを試みる。
        if (savedEvidencePaths.length > 0) {
          let evidenceDeleteSuccessCount = 0;
          let evidenceDeleteFailureCount = 0;
          let lastEvidenceDeleteFailureReason = "unknown";
          for (const imagePath of savedEvidencePaths) {
            try {
              await onedrive.deleteItem(imagePath);
              evidenceDeleteSuccessCount += 1;
            } catch (imageCleanupError) {
              const reason = imageCleanupError instanceof Error ? imageCleanupError.message : String(imageCleanupError);
              evidenceDeleteFailureCount += 1;
              lastEvidenceDeleteFailureReason = reason.trim() || "unknown";
              console.warn("OneDrive rollback image cleanup skipped.", {
                imagePath,
                reason,
              });
            }
          }
          if (evidenceDeleteFailureCount === 0) {
            rollbackEvidenceCleanup = "ok";
          } else if (evidenceDeleteSuccessCount > 0) {
            rollbackEvidenceCleanup = "partial";
          } else {
            rollbackEvidenceCleanup = `failed (${lastEvidenceDeleteFailureReason})`;
          }
          try {
            await onedrive.deleteItem(`${folderPath}/imgs`);
          } catch (imagesFolderCleanupError) {
            const reason =
              imagesFolderCleanupError instanceof Error
                ? imagesFolderCleanupError.message
                : String(imagesFolderCleanupError);
            console.warn("OneDrive rollback images folder cleanup skipped.", {
              folderPath,
              reason,
            });
          }
        }
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
          ? `rollback=ok evidenceCleanup=${rollbackEvidenceCleanup} folderCleanup=${rollbackFolderCleanup}`
          : `rollback=failed (${rollbackFailureReason})`
        : "rollback=not-attempted";
      throw new Error(`${raw} | partial-write: description.md saved then archive.json failed; ${rollbackInfo}`);
    }
    const evidenceSummary = summarizeEvidenceImages(evidenceImages);
    return Response.json(
      {
        ok: true,
        folderPath,
        evidenceImages: evidenceSummary,
        evidenceImageRecords: evidenceImages.map((record) => ({
          sourceUrl: record.sourceUrl,
          status: record.status,
          fileName: record.fileName,
          onedrivePath: record.onedrivePath,
          imageAccessToken: record.onedrivePath ? signEvidenceImagePath(record.onedrivePath) : null,
          webUrl: record.webUrl,
          errorReason: record.errorReason,
        })),
        alreadySavedFiles: {
          descriptionMd: descriptionMdAlreadySaved,
          archiveJson: archiveJsonAlreadySaved,
        },
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
    const message = isAuthLike
      ? "OneDrive 認証が切れています。再認証してから保存をやり直してください。"
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
        errorCode: undefined,
        errorMessage: undefined,
      } satisfies ApiOneDriveUploadResponse,
      { status },
    );
  }
}

/* 画像URL抽出の重複排除、ダウンロード再試行、拡張子補完の契約を固定する、
/ これらの機能を提供する関数は services/evidence-images.server.ts に切り出しているため、
/ ここでは保存された画像のパスを収集するロジックのみを実装する
 */
function collectSavedEvidencePaths(
  evidenceImages: EvidenceImageRecord[],
  writeError: unknown,
): string[] {
  const paths = new Set<string>();
  for (const record of evidenceImages) {
    if (record.status !== "success" || !record.onedrivePath) continue;
    paths.add(record.onedrivePath);
  }
  if (writeError instanceof EvidenceImagesSaveError) {
    for (const path of writeError.savedImagePaths) {
      if (path) paths.add(path);
    }
  }
  return Array.from(paths);
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

/* 
/ 画像URL抽出の重複排除、ダウンロード再試行、拡張子補完の契約を固定するため、
/ これらの機能を提供する関数は services/evidence-images.server.ts に切り出している。
*/
type EvidenceSaveDependencies = {
  saveBinary: (path: string, content: Uint8Array, contentType?: string) => Promise<{ name: string; webUrl: string }>;
  getItem: (path: string) => Promise<{ name: string; webUrl: string } | null>;
};

async function saveEvidenceImages({
  markdown,
  folderPath,
  onedrive,
  alreadySavedEvidenceBySource,
}: {
  markdown: string;
  folderPath: string;
  onedrive: EvidenceSaveDependencies;
  alreadySavedEvidenceBySource: Map<string, { fileName: string | null; onedrivePath: string | null; webUrl: string | null }>;
}): Promise<EvidenceImageRecord[]> {
  const urls = extractUniqueImageUrls(markdown);
  if (urls.length === 0) return [];

  const imagesFolder = `${folderPath}/imgs`;
  const reservedNames = new Set<string>();
  const results: EvidenceImageRecord[] = [];
  const maxImageBytes = getEvidenceImageMaxBytes();
  const maxImageCount = getEvidenceImageMaxCount();
  let consecutiveOneDriveSaveFailures = 0;

  for (const [index, sourceUrl] of urls.entries()) {
    const alreadySaved = alreadySavedEvidenceBySource.get(normalizeEvidenceSourceUrl(sourceUrl));
    if (alreadySaved && alreadySaved.onedrivePath) {
      results.push({
        sourceUrl,
        status: "success",
        fileName: alreadySaved.fileName,
        onedrivePath: alreadySaved.onedrivePath,
        webUrl: alreadySaved.webUrl,
        errorReason: ALREADY_SAVED_REASON,
      });
      continue;
    }
    if (index >= maxImageCount) {
      const remainingCount = urls.length - index;
      results.push({
        sourceUrl,
        status: "failed",
        fileName: null,
        onedrivePath: null,
        webUrl: null,
        errorReason: `${IMAGE_LIMIT_EXCEEDED_REMAINING_REASON}:${remainingCount}`,
      });
      break;
    }
    if (consecutiveOneDriveSaveFailures >= MAX_CONSECUTIVE_ONEDRIVE_SAVE_FAILURES) {
      results.push({
        sourceUrl,
        status: "failed",
        fileName: null,
        onedrivePath: null,
        webUrl: null,
        errorReason: ONEDRIVE_SAVE_SKIPPED_REASON,
      });
      continue;
    }
    const downloaded = await downloadImageWithRetry(sourceUrl, {
      timeoutMs: 180_000,
      maxAttempts: 3,
      maxBytes: maxImageBytes,
    });
    if ("ok" in downloaded) {
      consecutiveOneDriveSaveFailures = 0;
      results.push({
        sourceUrl,
        status: "failed",
        fileName: null,
        onedrivePath: null,
        webUrl: null,
        errorReason: downloaded.errorReason,
      });
      continue;
    }
    // ダウンロードは成功したが、Content-Type が画像でない場合は保存せずに失敗とする。
    // これにより、誤ってHTMLやJSONなどの非画像を保存してしまうリスクを減らす。
    if (!isImageContentType(downloaded.contentType)) {
      consecutiveOneDriveSaveFailures = 0;
      results.push({
        sourceUrl,
        status: "failed",
        fileName: null,
        onedrivePath: null,
        webUrl: null,
        errorReason: `UNSUPPORTED_CONTENT_TYPE: ${downloaded.contentType ?? "unknown"}`,
      });
      continue;
    }

    try {
      const baseName = buildImageBaseName(sourceUrl, downloaded.contentType);
      let fileName = await resolveEvidenceFileName({
        onedrive,
        folderPath: imagesFolder,
        baseName,
        reservedNames,
      });
      let onedrivePath = `${imagesFolder}/${fileName}`;
      let savedDriveItem: { name: string; webUrl: string } | null = null;
      for (let retry = 0; retry <= MAX_SAVE_CONFLICT_RETRIES; retry += 1) {
        try {
          savedDriveItem = await onedrive.saveBinary(onedrivePath, downloaded.bytes, downloaded.contentType ?? undefined);
          break;
        } catch (saveError) {
          if (
            saveError instanceof OneDriveApiError &&
            saveError.status === 412 &&
            retry < MAX_SAVE_CONFLICT_RETRIES
          ) {
            fileName = allocateLocalUniqueName(baseName, reservedNames);
            onedrivePath = `${imagesFolder}/${fileName}`;
            continue;
          }
          throw saveError;
        }
      }
      results.push({
        sourceUrl,
        status: "success",
        fileName,
        onedrivePath,
        webUrl: savedDriveItem?.webUrl ?? null,
        errorReason: null,
      });
      consecutiveOneDriveSaveFailures = 0;
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      // OneDrive への保存に失敗した場合、認証エラーっぽいかどうかに関わらず、まずはエラーメッセージを解析してみる。
      // これにより、OneDrive API のエラーレスポンスの形式が変わったり、予期しないエラーが発生した場合でも、ユーザーには再認証が必要な可能性があることを伝えることができる。
      if (isOneDriveAuthLikeError(rawMessage)) {
        const savedPaths = results
          .filter((record) => record.status === "success" && record.onedrivePath)
          .map((record) => record.onedrivePath as string);
        throw new EvidenceImagesSaveError(rawMessage, savedPaths);
      }
      if (error instanceof OneDriveApiError) {
        consecutiveOneDriveSaveFailures += 1;
        results.push({
          sourceUrl,
          status: "failed",
          fileName: null,
          onedrivePath: null,
          webUrl: null,
          errorReason: ONEDRIVE_SAVE_FAILED_REASON,
        });
        continue;
      }
      const parsed = extractOneDriveError(rawMessage);
      results.push({
        sourceUrl,
        status: "failed",
        fileName: null,
        onedrivePath: null,
        webUrl: null,
        errorReason: parsed.code
          ? `${parsed.code}: ${parsed.message ?? "save failed"}`
          : parsed.message ?? rawMessage,
      });
    }
  }
  return results;
}

function getEvidenceImageMaxBytes(): number {
  const kbRaw = process.env.ONEDRIVE_EVIDENCE_IMAGE_MAX_KB;
  const parsedKb = Number.parseInt(kbRaw ?? "", 10);
  if (Number.isFinite(parsedKb) && parsedKb > 0) {
    return Math.min(parsedKb * BYTES_PER_KILOBYTE, MAX_ONEDRIVE_SIMPLE_UPLOAD_BYTES);
  }

  // 後方互換: 旧bytes設定が残っている環境でも動作を維持する。
  const bytesRaw = process.env.ONEDRIVE_EVIDENCE_IMAGE_MAX_BYTES;
  const parsedBytes = Number.parseInt(bytesRaw ?? "", 10);
  if (Number.isFinite(parsedBytes) && parsedBytes > 0) {
    return Math.min(parsedBytes, MAX_ONEDRIVE_SIMPLE_UPLOAD_BYTES);
  }

  return Math.min(
    DEFAULT_EVIDENCE_IMAGE_MAX_KB * BYTES_PER_KILOBYTE,
    MAX_ONEDRIVE_SIMPLE_UPLOAD_BYTES,
  );
}

function getEvidenceImageMaxCount(): number {
  const raw = process.env.ONEDRIVE_EVIDENCE_IMAGE_MAX_COUNT;
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_EVIDENCE_IMAGE_MAX_COUNT;
  return parsed;
}

// Content-Type ヘッダーから画像の拡張子を推測して、ファイル名のベース部分を生成する。
// URLのパスから拡張子が取れる場合はそれを優先する。
function isImageContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    mime === "image/jpeg" ||
    mime === "image/jpg" ||
    mime === "image/png" ||
    mime === "image/gif" ||
    mime === "image/webp" ||
    mime === "image/avif"
  );
}
// 画像の拡張子を推測するための簡易マッピング。Content-Type が image/jpeg の場合は .jpg とするなど、一般的なケースをカバーする。
async function resolveEvidenceFileName({
  onedrive,
  folderPath,
  baseName,
  reservedNames,
}: {
  onedrive: EvidenceSaveDependencies;
  folderPath: string;
  baseName: string;
  reservedNames: Set<string>;
}): Promise<string> {
  // すでに予約済みならローカル採番を使う。同一リクエスト内の衝突を回避する。
  if (reservedNames.has(baseName)) {
    return allocateLocalUniqueName(baseName, reservedNames);
  }
  // OneDrive 上の存在確認は初回候補のみ。以降の衝突は saveBinary 側の 412 で検知して再採番する。
  const existing = await onedrive.getItem(`${folderPath}/${baseName}`);
  if (!existing) {
    reservedNames.add(baseName);
    return baseName;
  }
  reservedNames.add(baseName);
  return allocateLocalUniqueName(baseName, reservedNames);
}

function allocateLocalUniqueName(baseName: string, reservedNames: Set<string>): string {
  for (let index = 1; index <= 5000; index += 1) {
    const candidate = buildIndexedFileName(baseName, index);
    if (reservedNames.has(candidate)) continue;
    reservedNames.add(candidate);
    return candidate;
  }
  throw new Error(`Failed to allocate image filename: ${baseName}`);
}

function buildIndexedFileName(baseName: string, index: number): string {
  const { stem, ext } = splitFileName(baseName);
  return `${stem}-${index}${ext}`;
}

// ファイル名を拡張子とベース名に分割する。拡張子がない場合は ext を空文字列とする。
function splitFileName(fileName: string): { stem: string; ext: string } {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === fileName.length - 1) {
    return { stem: fileName, ext: "" };
  }
  return {
    stem: fileName.slice(0, dotIndex),
    ext: fileName.slice(dotIndex),
  };
}
// 画像URL抽出の重複排除、ダウンロード再試行、拡張子補完の契約を固定するため、
// これらの機能を提供する関数は services/evidence-images.server.ts に切り出している。
function summarizeEvidenceImages(records: EvidenceImageRecord[]): {
  total: number;
  success: number;
  failed: number;
  alreadySaved: number;
} {
  let success = 0;
  let failed = 0;
  let alreadySaved = 0;
  for (const record of records) {
    if (record.status === "success") {
      success += 1;
      if (record.errorReason === ALREADY_SAVED_REASON) {
        alreadySaved += 1;
      }
    } else {
      failed += 1;
    }
  }
  return {
    total: records.length,
    success,
    failed,
    alreadySaved,
  };
}

// すでに保存されている証拠画像を、sourceUrl をキーとするマップとして読み込む。これにより、同じ画像URLが複数回出現する場合でも、最初の1回だけ保存して残りは保存済みとしてスキップできるようになる。
async function loadExistingEvidenceBySource(
  onedrive: { getText: (path: string) => Promise<string>; getItem: (path: string) => Promise<{ name: string; webUrl: string } | null> },
  archivePath: string,
  archiveJsonAlreadySaved: boolean,
): Promise<Map<string, { fileName: string | null; onedrivePath: string | null; webUrl: string | null }>> {
  const result = new Map<string, { fileName: string | null; onedrivePath: string | null; webUrl: string | null }>();
  try {
    if (!archiveJsonAlreadySaved) return result;
    const raw = await onedrive.getText(archivePath);
    const parsed = JSON.parse(raw) as {
      evidenceImages?: Array<{
        sourceUrl?: string;
        status?: string;
        fileName?: string | null;
        onedrivePath?: string | null;
        webUrl?: string | null;
      }>;
    };
    for (const record of parsed.evidenceImages ?? []) {
      if (record.status !== "success" || !record.sourceUrl) continue;
      if (!record.onedrivePath) continue;
      let webUrl = record.webUrl ?? null;
      const savedItem = await onedrive.getItem(record.onedrivePath);
      if (!savedItem) continue;
      if (!webUrl) webUrl = savedItem.webUrl;
      result.set(normalizeEvidenceSourceUrl(record.sourceUrl), {
        fileName: record.fileName ?? null,
        onedrivePath: record.onedrivePath,
        webUrl,
      });
    }
    return result;
  } catch (error) {
    if (error instanceof OneDriveApiError && error.status === 404) {
      return result;
    }
    throw error;
  }
}

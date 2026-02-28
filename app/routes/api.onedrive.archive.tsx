/**
 * /api/onedrive/archive
 *
 * このファイルを用意した理由:
 * - 画面表示時に archive.json を優先参照し、保存済み画像を再現するため。
 *
 * このファイルが使われる場面:
 * - Parse後/Save後に archive.json を読み、カード表示用の evidenceImages を取得するとき。
 */
import type { ActionFunctionArgs } from "react-router";
import { createGitHubServiceFromEnv, type PullRequestRef } from "../services/github.server";
import { createOneDriveServiceFromEnv } from "../services/onedrive.server";
import { isOneDriveAuthLikeError } from "../services/onedrive-errors.server";
import { validatePrRefInput } from "../services/validation";
import { verifyCsrfToken } from "../services/csrf.server";
import { normalizeEvidenceSourceUrl } from "../services/evidence-url";
import { signEvidenceImagePath } from "../services/evidence-image-token.server";
import { mapWithConcurrencyLimit } from "../services/concurrency";
import { extractUniqueImageUrls } from "../services/evidence-images.server";
import { slugifyForPath } from "../services/path-utils";

type ArchiveEvidenceImage = {
  sourceUrl: string;
  normalizedSourceUrl: string;
  status: "success" | "failed";
  fileName: string | null;
  onedrivePath: string | null;
  imageAccessToken: string | null;
  webUrl: string | null;
  errorReason: string | null;
};

// archive.json の checklist.items を画面表示に渡すための最小契約。
type ArchiveChecklistItem = {
  line: number;
  text: string;
  checked: boolean;
};

export type ApiOneDriveArchiveResponse =
  | {
      ok: true;
      found: boolean;
      body: string;
      checklistItems: ArchiveChecklistItem[];
      evidenceImages: ArchiveEvidenceImage[];
    }
  | {
      ok: false;
      error: string;
      isAuthError: boolean;
      errorCode?: string;
      errorMessage?: string;
    };

const ARCHIVE_JSON_INVALID_ERROR_CODE = "ARCHIVE_JSON_INVALID";
const ARCHIVE_EVIDENCE_INTEGRITY_ERROR_CODE = "ARCHIVE_EVIDENCE_INTEGRITY_INVALID";
const ARCHIVE_PR_NOT_FOUND_ERROR_CODE = "ARCHIVE_PR_NOT_FOUND";
const ARCHIVE_PR_FOLDER_CONFLICT_ERROR_CODE = "ARCHIVE_PR_FOLDER_CONFLICT";
const ARCHIVE_EVIDENCE_LOOKUP_CONCURRENCY = 4;
// archive.json の内容が不正なときに投げるエラー。クライアント側での識別用。
class ArchiveJsonInvalidError extends Error {
  readonly errorCode: string;

  constructor() {
    super("Existing archive.json is invalid.");
    this.name = "ArchiveJsonInvalidError";
    this.errorCode = ARCHIVE_JSON_INVALID_ERROR_CODE;
  }
}

// archive.json と imgs 配下の対応が壊れているときに投げるエラー。
class ArchiveEvidenceIntegrityError extends Error {
  readonly errorCode: string;

  constructor(message: string) {
    super(message);
    this.name = "ArchiveEvidenceIntegrityError";
    this.errorCode = ARCHIVE_EVIDENCE_INTEGRITY_ERROR_CODE;
  }
}

// OneDrive API の 404 を「対象データ未存在」として扱える形に正規化する。
function isOneDriveNotFoundLikeError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "status" in error) {
    return (error as { status?: unknown }).status === 404;
  }
  if (error instanceof Error) {
    return /OneDrive API error \(404\)/.test(error.message);
  }
  return false;
}

// archive.json.checklist.items の型ガード。
function isChecklistItemRecord(value: unknown): value is ArchiveChecklistItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as { line?: unknown; text?: unknown; checked?: unknown };
  return (
    typeof item.line === "number" &&
    Number.isFinite(item.line) &&
    typeof item.text === "string" &&
    typeof item.checked === "boolean"
  );
}

// archive.json の必須部分（body/checklist.items/evidenceImages）を検証して返す。
function parseArchiveJson(raw: string): {
  body: string;
  checklistItems: ArchiveChecklistItem[];
  evidenceImages: Array<{
    sourceUrl?: string;
    status?: string;
    fileName?: string | null;
    onedrivePath?: string | null;
    webUrl?: string | null;
    errorReason?: string | null;
  }>;
} {
  let parsed: {
    body?: unknown;
    checklist?: { items?: unknown };
    evidenceImages?: unknown;
  };
  try {
    parsed = JSON.parse(raw) as {
      body?: unknown;
      checklist?: { items?: unknown };
      evidenceImages?: unknown;
    };
  } catch {
    throw new ArchiveJsonInvalidError();
  }
  const body = typeof parsed.body === "string" ? parsed.body : "";
  const rawChecklistItems = parsed.checklist?.items;
  if (!Array.isArray(rawChecklistItems) || !rawChecklistItems.every(isChecklistItemRecord)) {
    throw new ArchiveJsonInvalidError();
  }
  const rawEvidenceImages = parsed.evidenceImages;
  if (rawEvidenceImages !== undefined && !Array.isArray(rawEvidenceImages)) {
    throw new ArchiveJsonInvalidError();
  }
  return {
    body,
    checklistItems: rawChecklistItems,
    evidenceImages: (rawEvidenceImages ?? []) as Array<{
      sourceUrl?: string;
      status?: string;
      fileName?: string | null;
      onedrivePath?: string | null;
      webUrl?: string | null;
      errorReason?: string | null;
    }>,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const validation = validatePrRefInput(formData);
  if (!validation.ok) {
    return Response.json(
      { ok: false, error: validation.error, isAuthError: false } satisfies ApiOneDriveArchiveResponse,
      { status: 400 },
    );
  }
  if (!(await verifyCsrfToken(request, formData))) {
    return Response.json(
      {
        ok: false,
        error: "不正なリクエストです。ページを再読み込みして再試行してください。",
        isAuthError: false,
      } satisfies ApiOneDriveArchiveResponse,
      { status: 403 },
    );
  }

  const { owner, repo, prNumber } = validation;
  try {
    const onedrive = await createOneDriveServiceFromEnv(request);
    await onedrive.getDriveInfo();

    const baseFolder = (process.env.ONEDRIVE_BASE_FOLDER ?? "project").replace(/^\/+|\/+$/g, "");
    const workFolder = (process.env.ONEDRIVE_WORK_FOLDER ?? "").replace(/^\/+|\/+$/g, "");
    const rootPrefix = workFolder ? `${workFolder}/${baseFolder}` : baseFolder;
    const pullRequestsRoot = `${rootPrefix}/${repo}/PullRequests`;
    let prioritizedFolderName: string | null = null;
    try {
      const github = await createGitHubServiceFromEnv();
      const ref: PullRequestRef = {
        repo: { owner, name: repo },
        number: prNumber,
      };
      const pullRequest = await github.getPullRequest(ref);
      const safeTitle = slugifyForPath(pullRequest.title) || "untitled";
      prioritizedFolderName = `PR${prNumber}-${safeTitle}`;
    } catch {
      // GitHub 取得失敗時は OneDrive 側の保存済みフォルダ探索へフォールバックする。
    }

    let folderPath: string | null = null;
    if (prioritizedFolderName) {
      const prioritizedPath = `${pullRequestsRoot}/${prioritizedFolderName}`;
      const prioritizedFolder = await onedrive.getItem(prioritizedPath);
      if (prioritizedFolder) {
        folderPath = prioritizedPath;
      }
    }
    if (!folderPath) {
      let candidates: Array<{ name: string }> = [];
      try {
        candidates = await onedrive.listChildren(pullRequestsRoot, {
          nameStartsWith: `PR${prNumber}-`,
        });
      } catch (error) {
        if (!isOneDriveNotFoundLikeError(error)) {
          throw error;
        }
      }
      const matchedFolders = candidates.filter((item) => item.name.startsWith(`PR${prNumber}-`));
      if (matchedFolders.length > 1) {
        return Response.json(
          {
            ok: false,
            error:
              "OneDrive 上に同じPR番号の保存フォルダが複数あり、表示対象を特定できません。不要なフォルダを整理してください。",
            isAuthError: false,
            errorCode: ARCHIVE_PR_FOLDER_CONFLICT_ERROR_CODE,
            errorMessage: undefined,
          } satisfies ApiOneDriveArchiveResponse,
          { status: 409 },
        );
      }
      const folder = matchedFolders[0];
      if (folder) {
        folderPath = `${pullRequestsRoot}/${folder.name}`;
      }
    }
    if (!folderPath) {
      return Response.json(
        {
          ok: false,
          error: "OneDrive 上に保存済みのPRデータが見つかりません。",
          isAuthError: false,
          errorCode: ARCHIVE_PR_NOT_FOUND_ERROR_CODE,
          errorMessage: undefined,
        } satisfies ApiOneDriveArchiveResponse,
        { status: 404 },
      );
    }

    const archivePath = `${folderPath}/archive.json`;

    const archiveItem = await onedrive.getItem(archivePath);
    if (!archiveItem) {
      return Response.json(
        {
          ok: false,
          error: "OneDrive 上に保存済みの archive.json が見つかりません。",
          isAuthError: false,
          errorCode: ARCHIVE_PR_NOT_FOUND_ERROR_CODE,
          errorMessage: undefined,
        } satisfies ApiOneDriveArchiveResponse,
        { status: 404 },
      );
    }

    const raw = await onedrive.getText(archivePath);
    const parsed = parseArchiveJson(raw);
    const evidenceImages: ArchiveEvidenceImage[] = [];
    // sourceUrl(正規化後) の集合。本文Evidenceとの網羅性チェックに使う。
    const evidenceRecordSources = new Set<string>();
    // sourceUrl(正規化後) -> onedrivePath の対応。success レコードの実体確認に使う。
    const successEvidenceBySource = new Map<string, string>();
    const webUrlLookups: Array<{ evidenceIndex: number; onedrivePath: string; sourceUrl: string }> = [];

    for (const record of parsed.evidenceImages) {
      const sourceUrl = (record.sourceUrl ?? "").trim();
      if (!sourceUrl) continue;
      const normalizedSourceUrl = normalizeEvidenceSourceUrl(sourceUrl);
      evidenceRecordSources.add(normalizedSourceUrl);
      const webUrl = record.webUrl ?? null;
      const onedrivePath = record.onedrivePath ?? null;
      const status = record.status === "success" ? "success" : "failed";
      // success レコードは実体画像の存在を必須にし、欠落時は整合性エラーにする。
      if (status === "success") {
        if (!onedrivePath) {
          throw new ArchiveEvidenceIntegrityError("Missing onedrivePath in success evidence record.");
        }
        successEvidenceBySource.set(normalizedSourceUrl, onedrivePath);
        webUrlLookups.push({ evidenceIndex: evidenceImages.length, onedrivePath, sourceUrl });
      } else if (!webUrl && onedrivePath) {
        webUrlLookups.push({ evidenceIndex: evidenceImages.length, onedrivePath, sourceUrl });
      }
      evidenceImages.push({
        sourceUrl,
        normalizedSourceUrl,
        status,
        fileName: record.fileName ?? null,
        onedrivePath,
        imageAccessToken: onedrivePath ? signEvidenceImagePath(onedrivePath) : null,
        webUrl,
        errorReason: record.errorReason ?? null,
      });
    }

    if (webUrlLookups.length > 0) {
      const lookupResults = await mapWithConcurrencyLimit(
        webUrlLookups,
        ARCHIVE_EVIDENCE_LOOKUP_CONCURRENCY,
        async ({ onedrivePath }) => onedrive.getItem(onedrivePath),
      );
      for (let i = 0; i < lookupResults.length; i++) {
        const settled = lookupResults[i];
        if (settled.status === "rejected") {
          throw settled.reason;
        }
        const lookupTarget = webUrlLookups[i];
        if (!settled.value && evidenceImages[lookupTarget.evidenceIndex].status === "success") {
          throw new ArchiveEvidenceIntegrityError(
            `Missing imgs file for evidence source: ${lookupTarget.sourceUrl}`,
          );
        }
        if (settled.value) {
          evidenceImages[lookupTarget.evidenceIndex].webUrl = settled.value.webUrl;
        }
      }
    }
    // upload 側と同一ルール（extractUniqueImageUrls）で抽出した画像URLだけを網羅性検証する。
    const imageUrlsInBody = extractUniqueImageUrls(parsed.body);
    for (const imageUrl of imageUrlsInBody) {
      const normalized = normalizeEvidenceSourceUrl(imageUrl);
      if (!evidenceRecordSources.has(normalized)) {
        throw new ArchiveEvidenceIntegrityError(
          `Image URL is not covered by archive evidence records: ${imageUrl}`,
        );
      }
    }

    return Response.json(
      {
        ok: true,
        found: true,
        body: parsed.body,
        checklistItems: parsed.checklistItems,
        evidenceImages,
      } satisfies ApiOneDriveArchiveResponse,
      { status: 200 },
    );
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    if (error instanceof ArchiveJsonInvalidError) {
      return Response.json(
        {
          ok: false,
          error:
            "保存済みの archive.json が壊れています。OneDrive 上の archive.json を削除してから再取得してください。",
          isAuthError: false,
          errorCode: error.errorCode,
          errorMessage: undefined,
        } satisfies ApiOneDriveArchiveResponse,
        { status: 502 },
      );
    }
    if (error instanceof ArchiveEvidenceIntegrityError) {
      return Response.json(
        {
          ok: false,
          error:
            "保存済みの archive.json と imgs 配下の画像対応が壊れています。OneDrive 上の archive.json と imgs を確認してください。",
          isAuthError: false,
          errorCode: error.errorCode,
          errorMessage: undefined,
        } satisfies ApiOneDriveArchiveResponse,
        { status: 502 },
      );
    }
    const isAuthLike = isOneDriveAuthLikeError(rawMessage);
    const message = isAuthLike
      ? "OneDrive 認証が切れています。再認証してから再実行してください。"
      : "OneDrive 上の archive.json 取得に失敗しました。しばらくしてから再実行してください。";

    return Response.json(
      {
        ok: false,
        error: message,
        isAuthError: isAuthLike,
        errorCode: undefined,
        errorMessage: undefined,
      } satisfies ApiOneDriveArchiveResponse,
      { status: isAuthLike ? 401 : 502 },
    );
  }
}

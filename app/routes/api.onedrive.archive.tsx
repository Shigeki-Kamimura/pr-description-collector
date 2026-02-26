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
import { getHttpStatus } from "../services/http-status";
import { isOneDriveAuthLikeError } from "../services/onedrive-errors.server";
import { validatePrRefInput } from "../services/validation";
import { verifyCsrfToken } from "../services/csrf.server";
import { normalizeEvidenceSourceUrl } from "../services/evidence-url";
import { signEvidenceImagePath } from "../services/evidence-image-token.server";
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

export type ApiOneDriveArchiveResponse =
  | {
      ok: true;
      found: boolean;
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
// archive.json の内容が不正なときに投げるエラー。クライアント側での識別用。
class ArchiveJsonInvalidError extends Error {
  readonly errorCode: string;

  constructor() {
    super("Existing archive.json is invalid.");
    this.name = "ArchiveJsonInvalidError";
    this.errorCode = ARCHIVE_JSON_INVALID_ERROR_CODE;
  }
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
  let failureDomain: "github" | "onedrive" = "github";
  try {
    const github = await createGitHubServiceFromEnv();
    failureDomain = "onedrive";
    const onedrive = await createOneDriveServiceFromEnv(request);
    await onedrive.getDriveInfo();

    failureDomain = "github";
    const ref: PullRequestRef = {
      repo: { owner, name: repo },
      number: prNumber,
    };
    const pullRequest = await github.getPullRequest(ref);

    failureDomain = "onedrive";
    const baseFolder = (process.env.ONEDRIVE_BASE_FOLDER ?? "project").replace(/^\/+|\/+$/g, "");
    const workFolder = (process.env.ONEDRIVE_WORK_FOLDER ?? "").replace(/^\/+|\/+$/g, "");
    const safeTitle = slugifyForPath(pullRequest.title) || "untitled";
    const rootPrefix = workFolder ? `${workFolder}/${baseFolder}` : baseFolder;
    const folderPath = `${rootPrefix}/${repo}/PullRequests/PR${prNumber}-${safeTitle}`;
    const archivePath = `${folderPath}/archive.json`;

    const archiveItem = await onedrive.getItem(archivePath);
    if (!archiveItem) {
      return Response.json(
        { ok: true, found: false, evidenceImages: [] } satisfies ApiOneDriveArchiveResponse,
        { status: 200 },
      );
    }

    const raw = await onedrive.getText(archivePath);
    let parsed: {
      evidenceImages?: Array<{
        sourceUrl?: string;
        status?: string;
        fileName?: string | null;
        onedrivePath?: string | null;
        webUrl?: string | null;
        errorReason?: string | null;
      }>;
    };
    try {
      parsed = JSON.parse(raw) as {
        evidenceImages?: Array<{
          sourceUrl?: string;
          status?: string;
          fileName?: string | null;
          onedrivePath?: string | null;
          webUrl?: string | null;
          errorReason?: string | null;
        }>;
      };
    } catch {
      throw new ArchiveJsonInvalidError();
    }
    const evidenceImages: ArchiveEvidenceImage[] = [];
    for (const record of parsed.evidenceImages ?? []) {
      const sourceUrl = (record.sourceUrl ?? "").trim();
      if (!sourceUrl) continue;
      let webUrl = record.webUrl ?? null;
      if (!webUrl && record.onedrivePath) {
        const item = await onedrive.getItem(record.onedrivePath);
        webUrl = item?.webUrl ?? null;
      }
      evidenceImages.push({
        sourceUrl,
        normalizedSourceUrl: normalizeEvidenceSourceUrl(sourceUrl),
        status: record.status === "success" ? "success" : "failed",
        fileName: record.fileName ?? null,
        onedrivePath: record.onedrivePath ?? null,
        imageAccessToken: record.onedrivePath ? signEvidenceImagePath(record.onedrivePath) : null,
        webUrl,
        errorReason: record.errorReason ?? null,
      });
    }

    return Response.json(
      {
        ok: true,
        found: true,
        evidenceImages,
      } satisfies ApiOneDriveArchiveResponse,
      { status: 200 },
    );
  } catch (error) {
    if (failureDomain === "github") {
      const status = getHttpStatus(error);
      if (status !== null) {
        switch (status) {
          case 401:
            return Response.json(
              { ok: false, error: "GitHub認証に失敗しました。トークンを確認してください。", isAuthError: false },
              { status: 401 },
            );
          case 403:
            return Response.json(
              { ok: false, error: "アクセスが拒否されました。権限またはレート制限を確認してください。", isAuthError: false },
              { status: 403 },
            );
          case 404:
            return Response.json(
              { ok: false, error: "指定されたPRが見つかりません。owner/repo/prNumber を確認してください。", isAuthError: false },
              { status: 404 },
            );
          case 429:
            return Response.json(
              { ok: false, error: "レート制限のため一時的に失敗しました。しばらくしてから再実行してください。", isAuthError: false },
              { status: 429 },
            );
          default:
            return Response.json(
              { ok: false, error: "GitHub API への接続に失敗しました。しばらくしてから再実行してください。", isAuthError: false },
              { status: 502 },
            );
        }
      }
      return Response.json(
        { ok: false, error: "GitHub API への接続に失敗しました。しばらくしてから再実行してください。", isAuthError: false },
        { status: 502 },
      );
    }

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

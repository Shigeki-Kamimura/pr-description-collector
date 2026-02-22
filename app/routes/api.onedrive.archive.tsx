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
import { extractOneDriveError, isOneDriveAuthLikeError } from "../services/onedrive-errors.server";
import { validatePrRefInput } from "../services/validation";
import { verifyCsrfToken } from "../services/csrf.server";
import { normalizeEvidenceSourceUrl } from "../services/evidence-url";

type ArchiveEvidenceImage = {
  sourceUrl: string;
  normalizedSourceUrl: string;
  status: "success" | "failed";
  fileName: string | null;
  onedrivePath: string | null;
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
    const parsed = JSON.parse(raw) as {
      evidenceImages?: Array<{
        sourceUrl?: string;
        status?: string;
        fileName?: string | null;
        onedrivePath?: string | null;
        webUrl?: string | null;
        errorReason?: string | null;
      }>;
    };
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
    const parsed = extractOneDriveError(rawMessage);
    const isAuthLike = isOneDriveAuthLikeError(rawMessage);
    const hasDetail = Boolean(parsed.code || parsed.message);
    const message = isAuthLike
      ? hasDetail
        ? `${parsed.code ?? "UNKNOWN"}: ${parsed.message ?? rawMessage}`
        : "OneDrive 認証が切れています。再認証してから再実行してください。"
      : "OneDrive 上の archive.json 取得に失敗しました。しばらくしてから再実行してください。";

    return Response.json(
      {
        ok: false,
        error: message,
        isAuthError: isAuthLike,
        errorCode: isAuthLike ? parsed.code : undefined,
        errorMessage: isAuthLike ? parsed.message ?? rawMessage : undefined,
      } satisfies ApiOneDriveArchiveResponse,
      { status: isAuthLike ? 401 : 502 },
    );
  }
}

function slugifyForPath(value: string): string {
  const normalized = value
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "");

  const maxCodePoints = 80;
  const maxUtf8Bytes = 160;
  const encoder = new TextEncoder();
  let result = "";
  let codePointCount = 0;
  let utf8ByteCount = 0;

  for (const char of normalized) {
    const charBytes = encoder.encode(char).length;
    if (codePointCount + 1 > maxCodePoints || utf8ByteCount + charBytes > maxUtf8Bytes) break;
    result += char;
    codePointCount += 1;
    utf8ByteCount += charBytes;
  }

  return result;
}

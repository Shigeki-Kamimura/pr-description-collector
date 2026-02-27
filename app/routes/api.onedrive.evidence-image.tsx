/**
 * /api/onedrive/evidence-image
 *
 * このファイルを用意した理由:
 * - OneDrive の webUrl ではなく、アプリ内API経由で保存済みエビデンス画像を安定表示するため。
 *
 * このファイルが使われる場面:
 * - チェックリストカード描画時に、archive.json の onedrivePath から画像を取得するとき。
 */
import type { LoaderFunctionArgs } from "react-router";
import { createOneDriveServiceFromEnv, OneDriveApiError } from "../services/onedrive.server";
import { extractOneDriveError, isOneDriveAuthLikeError } from "../services/onedrive-errors.server";
import {
  isEvidenceImageTokenFormat,
  verifyEvidenceImagePathToken,
} from "../services/evidence-image-token.server";

const MAX_PATH_LENGTH = 1024;
const ALLOWED_EVIDENCE_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const TEXT_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
// 設計メモ: OneDrive上のファイルパスは、相対パスであり、かつ特定の文字列パターンを満たす必要があると想定している。
function buildAllowedPathPrefix(): string {
  const baseFolder = (process.env.ONEDRIVE_BASE_FOLDER ?? "project").replace(/^\/+|\/+$/g, "");
  const workFolder = (process.env.ONEDRIVE_WORK_FOLDER ?? "").replace(/^\/+|\/+$/g, "");
  return workFolder ? `${workFolder}/${baseFolder}/` : `${baseFolder}/`;
}
// セキュリティ設計: OneDrive上のファイルパスは、相対パスであり、かつ特定の文字列パターンを満たす必要があると想定している。
function isValidOneDrivePath(path: string): boolean {
  if (!path) return false;
  if (path.length > MAX_PATH_LENGTH) return false;
  if (path.includes("..")) return false;
  if (path.startsWith("/")) return false;
  if (!path.startsWith(buildAllowedPathPrefix())) return false;
  if (!path.includes("/PullRequests/")) return false;
  if (!path.includes("/imgs/")) return false;
  return true;
}

function textResponse(status: number, body: string, extraHeaders?: Record<string, string>): Response {
  return new Response(body, {
    status,
    headers: {
      ...TEXT_HEADERS,
      ...(extraHeaders ?? {}),
    },
  });
}

function toMime(contentType: string | null | undefined): string {
  return contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
}
// 設計メモ: OneDrive APIからのエラーで、認証関連のエラーと判断されるものが発生した場合は、401を返す。
// これにより、フロントエンドは認証エラーとそれ以外のエラーを区別して適切にユーザーにフィードバックできるようになる。
export async function loader({ request }: LoaderFunctionArgs) {
  const requestUrl = new URL(request.url);
  const onedrivePath = (requestUrl.searchParams.get("path") ?? "").trim();
  const token = (requestUrl.searchParams.get("token") ?? "").trim();

  if (!isValidOneDrivePath(onedrivePath)) {
    return textResponse(400, "invalid evidence image path");
  }
  if (!isEvidenceImageTokenFormat(token)) {
    return textResponse(400, "invalid evidence image token");
  }
  if (!verifyEvidenceImagePathToken(onedrivePath, token)) {
    return textResponse(403, "invalid evidence image token");
  }

  try {
    const onedrive = await createOneDriveServiceFromEnv(request);
    const downloaded = await onedrive.getBinary(onedrivePath);
    const mime = toMime(downloaded.contentType);
    if (!ALLOWED_EVIDENCE_IMAGE_MIME_TYPES.has(mime)) {
      return textResponse(415, "unsupported evidence content-type");
    }

    const bytes = downloaded.bytes;
    const sourceBuffer = bytes.buffer;
    const arrayBuffer =
      sourceBuffer instanceof SharedArrayBuffer
        ? Uint8Array.from(bytes).buffer
        : (sourceBuffer as ArrayBuffer);
    const bodyBuffer =
      bytes.byteOffset === 0 && bytes.byteLength === arrayBuffer.byteLength
        ? arrayBuffer
        : arrayBuffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

    return new Response(bodyBuffer, {
      status: 200,
      headers: {
        "Content-Type": mime || "application/octet-stream",
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof OneDriveApiError) {
      if (error.status === 404) {
        return textResponse(404, "evidence image not found");
      }
      if (error.status === 403) {
        return textResponse(403, "onedrive access denied");
      }
      if (error.status === 401) {
        return textResponse(401, "onedrive auth required");
      }
      if (error.status === 429) {
        return textResponse(429, "onedrive rate limited", {
          ...(error.retryAfterRaw
            ? { "Retry-After": error.retryAfterRaw }
            : error.retryAfterSeconds !== undefined
              ? { "Retry-After": String(error.retryAfterSeconds) }
              : error.retryAfterAtIso
                ? { "Retry-After": new Date(error.retryAfterAtIso).toUTCString() }
                : {}),
        });
      }
      if (error.status === 413) {
        return textResponse(413, "evidence image too large");
      }
    }

    const rawMessage = error instanceof Error ? error.message : String(error);
    const isAuthLike = isOneDriveAuthLikeError(rawMessage);
    if (isAuthLike) {
      const parsed = extractOneDriveError(rawMessage);
      const status = parsed.code === "accessDenied" ? 403 : 401;
      return textResponse(status, status === 403 ? "onedrive access denied" : "onedrive auth required");
    }

    return textResponse(502, "failed to fetch evidence image");
  }
}

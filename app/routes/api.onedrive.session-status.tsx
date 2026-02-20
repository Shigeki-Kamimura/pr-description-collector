/**
 * /api/onedrive/session-status
 *
 * 責務:
 * - OAuth Cookie セッションに紐づく OneDrive トークンの有効性を確認する
 *
 * 境界:
 * - 成功時は drive 情報を返す
 * - 失敗時は UI が分岐しやすいよう `isAuthError` を返す
 */
import type { LoaderFunctionArgs } from "react-router";
import { extractOneDriveError, isOneDriveAuthLikeError } from "../services/onedrive-errors.server";
import { getAccessToken } from "../services/onedrive-auth.server";
import { createOneDriveService } from "../services/onedrive.server";

export type ApiOneDriveSessionStatusResponse =
  | {
      ok: true;
      drive: {
        id: string;
        driveType: string | null;
      };
    }
  | {
      ok: false;
      error: string;
      isAuthError: boolean;
      errorCode?: string;
      errorMessage?: string;
    };

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    const accessToken = await getAccessToken(request);
    const onedrive = createOneDriveService({ accessToken });
    const drive = await onedrive.getDriveInfo();
    return Response.json(
      {
        ok: true,
        drive: {
          id: drive.id,
          driveType: drive.driveType,
        },
      } satisfies ApiOneDriveSessionStatusResponse,
      { status: 200 },
    );
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "Unknown error";
    const parsed = extractOneDriveError(rawMessage);
    const isAuthLike = isOneDriveAuthLikeError(rawMessage);

    const hasDetail = Boolean(parsed.code || parsed.message);
    const message = isAuthLike
      ? hasDetail
        ? `${parsed.code ?? "UNKNOWN"}: ${parsed.message ?? rawMessage}`
        : "OneDrive 認証が有効ではありません。Connect OneDrive から再認証してください。"
      : "OneDrive セッション確認に失敗しました。しばらくしてから再実行してください。";
    if (!isAuthLike) {
      // 認証エラーの可能性が低いエラーは、内部的な詳細をログに残す。
      // これにより、ユーザーには定型のエラーメッセージのみを返しつつ、開発者は問題の診断に必要な情報を得られるようになる。
      console.error("OneDrive session-status failed.", {
        message: rawMessage,
        code: parsed.code,
        detail: parsed.message,
      });
    }

    return Response.json(
      {
        ok: false,
        error: message,
        isAuthError: isAuthLike,
        errorCode: isAuthLike ? parsed.code : undefined,
        errorMessage: isAuthLike ? parsed.message ?? rawMessage : undefined,
      } satisfies ApiOneDriveSessionStatusResponse,
      { status: isAuthLike ? 401 : 502 },
    );
  }
}

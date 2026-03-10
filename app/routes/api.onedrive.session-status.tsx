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
import { logger } from "../services/logger.server";
import { buildOneDriveAuditErrorPayload } from "../services/onedrive-audit-log.server";
import { extractOneDriveError, isOneDriveAuthLikeError, resolveOneDriveAuthStatus } from "../services/onedrive-errors.server";
import { getAccessToken, isOneDriveOAuthTokenMissingError } from "../services/onedrive-auth.server";
import { isOAuthSessionStoreUnavailableError } from "../services/onedrive-oauth-session.server";
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
    if (isOAuthSessionStoreUnavailableError(error)) {
      logger.error("OneDrive session-status failed due to session store outage.", {
        ...buildOneDriveAuditErrorPayload({
          event: "onedrive.session-store-unavailable",
          route: "api/onedrive/session-status",
          error,
          status: 503,
          failureType: "session-store",
        }),
      });
      return Response.json(
        {
          ok: false,
          error: "OneDrive 認証基盤で一時障害が発生しています。時間をおいて再試行してください。",
          isAuthError: false,
        } satisfies ApiOneDriveSessionStatusResponse,
        { status: 503 },
      );
    }
    const rawMessage = error instanceof Error ? error.message : "Unknown error";
    const parsed = extractOneDriveError(rawMessage);
    const isAuthLike = isOneDriveOAuthTokenMissingError(error) || isOneDriveAuthLikeError(rawMessage);
    const authStatus = resolveOneDriveAuthStatus(rawMessage, parsed.code);
    const message = isAuthLike
      ? authStatus === 403
        ? "OneDrive へのアクセスが拒否されました。権限を確認してください。"
        : "OneDrive 認証が有効ではありません。Connect OneDrive から再認証してください。"
      : "OneDrive セッション確認に失敗しました。しばらくしてから再実行してください。";
    if (isAuthLike) {
      logger.warn(
        "OneDrive session-status auth-like failure.",
        buildOneDriveAuditErrorPayload({
          event: "onedrive.auth-failure",
          route: "api/onedrive/session-status",
          error,
          status: authStatus,
          failureType: "onedrive-auth",
          extra: {
            code: parsed.code ?? null,
            detail: parsed.message ?? null,
          },
        }),
      );
    } else {
      logger.error(
        "OneDrive session-status failed.",
        buildOneDriveAuditErrorPayload({
          event: "onedrive.session-status-failed",
          route: "api/onedrive/session-status",
          error,
          status: 502,
          failureType: "onedrive-non-auth",
          extra: {
            code: parsed.code ?? null,
            detail: parsed.message ?? null,
          },
        }),
      );
    }

    return Response.json(
      {
        ok: false,
        error: message,
        isAuthError: isAuthLike && authStatus === 401,
        errorCode: isAuthLike ? parsed.code : undefined,
        // 詳細文は機微情報混入リスクがあるためレスポンスには載せない。
        errorMessage: undefined,
      } satisfies ApiOneDriveSessionStatusResponse,
      { status: isAuthLike ? authStatus : 502 },
    );
  }
}

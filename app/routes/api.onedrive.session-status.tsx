/*
  OneDriveセッション状態確認API
  Cookieセッションに紐づくOneDriveアクセストークンでドライブ情報を取得できるか確認する。
  レスポンスはJSON形式。
*/


import type { LoaderFunctionArgs } from "react-router";
import { createOneDriveServiceFromEnv } from "../services/onedrive.server";

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
      errorCode?: string;
      errorMessage?: string;
    };

function extractOneDriveError(rawMessage: string): { code?: string; message?: string } {
  const codeMatch = rawMessage.match(/\[code=([^\]]+)\]/);
  const messageMatch = rawMessage.match(/OneDrive API error \(\d+\)(?: \[code=[^\]]+\])?:\s*([^()]+?)(?:\s+\(token|$)/);
  return {
    code: codeMatch?.[1],
    message: messageMatch?.[1]?.trim(),
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    // requestのCookieセッションを使って現在のOneDriveドライブへアクセスできるか検証する
    const onedrive = await createOneDriveServiceFromEnv(request);
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
    const isAuthLike =
      rawMessage.includes("OAuth token") ||
      rawMessage.includes("認証") ||
      rawMessage.includes("OneDrive API error (401)") ||
      rawMessage.includes("OneDrive API error (403)");

    const hasDetail = Boolean(parsed.code || parsed.message);
    const message = isAuthLike
      ? hasDetail
        ? `${parsed.code ?? "UNKNOWN"}: ${parsed.message ?? rawMessage}`
        : "OneDrive 認証が有効ではありません。Connect OneDrive から再認証してください。"
      : `OneDrive セッション確認に失敗しました: ${rawMessage}`;

    return Response.json(
      {
        ok: false,
        error: message,
        errorCode: parsed.code,
        errorMessage: parsed.message ?? rawMessage,
      } satisfies ApiOneDriveSessionStatusResponse,
      { status: 502 },
    );
  }
}

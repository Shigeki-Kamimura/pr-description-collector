/*
  OneDriveセッション状態確認API
  OAuthで発行した Cookie セッションに紐づく OneDrive アクセストークンで
  ドライブ情報を取得できるか確認する。
  レスポンスはJSON形式。
*/

import type { LoaderFunctionArgs } from "react-router";
// OneDrive認証とトークン管理のユーティリティ
import { extractOneDriveError, isOneDriveAuthLikeError } from "../services/onedrive-errors.server";
// OneDriveサービスの生成ユーティリティ
import { getAccessToken } from "../services/onedrive-auth.server";
// OneDriveサービスの生成ユーティリティ
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
      errorCode?: string;
      errorMessage?: string;
    };

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    // OAuth cookie セッションに紐づくアクセストークンで現在のOneDriveドライブへアクセスできるか検証する
    const accessToken = await getAccessToken(request);
    // OneDriveサービスを作成してドライブ情報を取得する。これに成功すればセッションは有効と判断できる。
    const onedrive = createOneDriveService({ accessToken });
    // ドライブ情報を取得してセッションの有効性を確認する。これに成功すればセッションは有効と判断できる。
    const drive = await onedrive.getDriveInfo();
    // 成功レスポンスを返す。ドライブIDとドライブタイプを含める。
    return Response.json(
      {
        ok: true, // セッションが有効であることを示すフラグ
        drive: {  //  ドライブ情報を含むオブジェクト
          id: drive.id,
          driveType: drive.driveType,
        },
      } satisfies ApiOneDriveSessionStatusResponse, //  レスポンスの型を指定
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
      : `OneDrive セッション確認に失敗しました: ${rawMessage}`;

    return Response.json(
      {
        ok: false,
        error: message,
        errorCode: parsed.code,
        errorMessage: parsed.message ?? rawMessage,
      } satisfies ApiOneDriveSessionStatusResponse,
      { status: isAuthLike ? 401 : 502 },
    );
  }
}

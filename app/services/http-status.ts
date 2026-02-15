/**
 * HTTPエラーからステータスコードを抽出する共通ユーティリティ。
 *
 * 境界:
 * - Octokit RequestError と、status フィールドを持つ汎用エラーを扱う
 * - 判定できない場合は null を返す
 */
import { RequestError } from "@octokit/request-error";

export function getHttpStatus(error: unknown): number | null {
  if (error instanceof RequestError) return error.status;
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof (error as { status?: unknown }).status === "number"
  ) {
    return (error as { status: number }).status;
  }
  return null;
}

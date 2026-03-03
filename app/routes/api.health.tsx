/**
 * /api/health
 *
 * このファイルを用意した理由:
 * - Docker / PaaS の healthcheck から、依存のない軽量な疎通確認先を提供するため。
 *
 * このファイルが使われる場面:
 * - コンテナ起動後に、アプリの HTTP 応答可否だけを確認するとき。
 */
import type { LoaderFunctionArgs } from "react-router";

export type ApiHealthResponse = {
  ok: true;
  status: "healthy";
};

// 外部依存は見ず、アプリが HTTP 応答できるかだけを返す。
export async function loader(_args: LoaderFunctionArgs) {
  return Response.json(
    {
      ok: true,
      status: "healthy",
    } satisfies ApiHealthResponse,
    { status: 200 },
  );
}

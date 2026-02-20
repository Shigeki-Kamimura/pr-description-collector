/**
 * セッション署名シークレットの共通解決モジュール
 *
 * このファイルが必要な理由:
 * - OAuth系Cookie（state/bind/session）とCSRF Cookieで、同じ署名鍵解決ロジックを再利用するため。
 * - 各ファイルで `SESSION_SECRET` 判定や開発用フォールバック警告を重複実装しないため。
 *
 * 作用:
 * - `SESSION_SECRET` を読み取り、productionでは未設定を即時エラーにする。
 * - developmentでは未設定時に固定の開発用シークレットを使い、警告を出す。
 * - `resolvedSessionSecret` をexportし、Cookie `secrets` に共通利用させる。
 */
const sessionSecret = process.env.SESSION_SECRET ?? "";
export const isProduction = process.env.NODE_ENV === "production";
const defaultDevSessionSecret =
  "dev-session-secret-pr-description-collector-please-set-session-secret-explicitly";
const usingDefaultDevSessionSecret = !sessionSecret && !isProduction;

export const resolvedSessionSecret =
  sessionSecret || (usingDefaultDevSessionSecret ? defaultDevSessionSecret : "");

if (!resolvedSessionSecret) {
  throw new Error("SESSION_SECRET が未設定です。production では必須です。");
}

if (usingDefaultDevSessionSecret) {
  console.warn(
    "SESSION_SECRET が未設定のため、固定の開発用シークレットを使用しています。ローカルの安定運用のため、.env に SESSION_SECRET を明示設定してください。",
  );
}

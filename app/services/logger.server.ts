/* eslint-disable no-console */
/**
 * サーバー向けロガー
 *
 * このファイルを用意した理由:
 * - server route/service から `console` 直接呼び出しをなくし、ログ出力の入口を1か所に寄せるため。
 * - 将来の構造化ログや外部転送へ差し替えやすくするため。
 *
 * このファイルが使われる場面:
 * - OAuth/Redis/OneDrive 障害や rollback 失敗などをサーバーログへ残すとき。
 */

type LogPayload = Record<string, unknown> | undefined;

function write(method: "warn" | "error", message: string, payload?: LogPayload) {
  if (payload) {
    console[method](message, payload);
    return;
  }
  console[method](message);
}

export const logger = {
  warn(message: string, payload?: LogPayload) {
    write("warn", message, payload);
  },
  error(message: string, payload?: LogPayload) {
    write("error", message, payload);
  },
};

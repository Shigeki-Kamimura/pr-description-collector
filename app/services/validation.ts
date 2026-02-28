/**
 * PR 参照入力（owner/repo/prNumber）の共通バリデーション。
 *
 * このファイルを用意した理由:
 * - owner/repo/prNumber の入力ルールを1か所に集約し、画面とAPIでズレないようにするため。
 *
 * このファイルが使われる場面:
 * - `Get Description`、`Parse Checklist`、OneDrive 系 API が PR 参照入力を検証するとき。
 */
export type PrRefValidationResult =
  | { ok: true; owner: string; repo: string; prNumber: number }
  | { ok: false; error: string };

export const INVALID_PR_REF_ERROR = "owner/repo/prNumber を正しく指定してください";

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const PR_NUMBER_PATTERN = /^[1-9][0-9]*$/;

// 文字列入力を受け取って、要件どおりの PR 参照に変換できるかを判定する本体。
export function validatePrRefFields(
  ownerInput: string,
  repoInput: string,
  prNumberInput: string,
): PrRefValidationResult {
  const owner = ownerInput.trim();
  const repo = repoInput.trim();
  const prNumberRaw = prNumberInput.trim();

  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || !PR_NUMBER_PATTERN.test(prNumberRaw)) {
    return { ok: false, error: INVALID_PR_REF_ERROR };
  }

  const prNumber = Number.parseInt(prNumberRaw, 10);
  return { ok: true, owner, repo, prNumber };
}
// FormData から取り出す入口。各 route からはこの関数を呼べば同一ルールを使える。
export function validatePrRefInput(formData: FormData): PrRefValidationResult {
  const owner = String(formData.get("owner") ?? "");
  const repo = String(formData.get("repo") ?? "");
  const prNumberRaw = String(formData.get("prNumber") ?? "");
  return validatePrRefFields(owner, repo, prNumberRaw);
}

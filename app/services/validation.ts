/**
 * PR 参照入力（owner/repo/prNumber）の共通バリデーション。
 *
 * 境界:
 * - フロントエンドとバックエンドで同一ルールを使う
 * - 要件定義の許容文字/長さをこのモジュールに集約する
 */
export type PrRefValidationResult =
  | { ok: true; owner: string; repo: string; prNumber: number }
  | { ok: false; error: string };

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const PR_NUMBER_PATTERN = /^[1-9][0-9]*$/;

export function validatePrRefInput(formData: FormData): PrRefValidationResult {
  const owner = String(formData.get("owner") ?? "").trim();
  const repo = String(formData.get("repo") ?? "").trim();
  const prNumberRaw = String(formData.get("prNumber") ?? "").trim();

  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || !PR_NUMBER_PATTERN.test(prNumberRaw)) {
    return { ok: false, error: "owner/repo/prNumber を正しく指定してください" };
  }

  const prNumber = Number.parseInt(prNumberRaw, 10);
  return { ok: true, owner, repo, prNumber };
}

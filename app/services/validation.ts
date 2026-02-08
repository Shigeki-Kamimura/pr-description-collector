// PR のオーナー、リポジトリ名、PR番号の入力をバリデーションするユーティリティ
export type PrRefValidationResult =
  | { ok: true; owner: string; repo: string; prNumber: number }
  | { ok: false; error: string };

export function validatePrRefInput(formData: FormData): PrRefValidationResult {
  const owner = String(formData.get("owner") ?? "").trim();
  const repo = String(formData.get("repo") ?? "").trim();
  const prNumberRaw = String(formData.get("prNumber") ?? "").trim();
  const prNumber = Number(prNumberRaw);

  // 最低限の入力チェック（詳細バリデーションは別タスクで実施）
  if (!owner || !repo || !Number.isInteger(prNumber) || prNumber <= 0) {
    return { ok: false, error: "owner/repo/prNumber を正しく指定してください" };
  }

  return { ok: true, owner, repo, prNumber };
}

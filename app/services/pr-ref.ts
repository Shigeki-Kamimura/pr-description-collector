/**
 * PR参照ユーティリティ（owner/repo/prNumber）
 *
 * このファイルを用意した理由:
 * - 画面側で「最後に取得したPR参照」と「現在入力中のPR参照」の一致判定を
 *   再利用可能かつテスト可能な純粋関数として分離するため。
 *
 * このファイルが使われる場面:
 * - `routes/_index.tsx` で Save to OneDrive の活性条件を判定するとき。
 * - 入力値の前後空白を正規化して、意図しない不一致を防ぐとき。
 */

export type PrRefInput = {
  owner: string;
  repo: string;
  prNumber: string;
};

// フォーム入力由来の余分な空白を除去して比較可能な形にする。
export function normalizePrRef(value: PrRefInput): PrRefInput {
  return {
    owner: value.owner.trim(),
    repo: value.repo.trim(),
    prNumber: value.prNumber.trim(),
  };
}

// Save対象と最後に取得したPR参照が同一かを判定する。
export function isSamePrRef(left: PrRefInput | null, right: PrRefInput): boolean {
  if (!left) return false;
  return (
    left.owner === right.owner &&
    left.repo === right.repo &&
    left.prNumber === right.prNumber
  );
}

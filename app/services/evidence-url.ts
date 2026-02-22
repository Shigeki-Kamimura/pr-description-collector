/**
 * エビデンス画像URL正規化ユーティリティ
 *
 * このファイルを用意した理由:
 * - 保存時と表示時でURL比較ロジックを統一し、表記ゆれによるミスマッチを防ぐため。
 *
 * このファイルが使われる場面:
 * - archive.json の sourceUrl と、PR本文から抽出した Evidence URL を照合するとき。
 */
// エビデンス画像URLの比較用に、表記ゆれを吸収して正規化する。
export function normalizeEvidenceSourceUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.replace(/\/+$/g, "");
    }
    const sortedParams = Array.from(parsed.searchParams.entries()).sort((a, b) => {
      if (a[0] === b[0]) return a[1].localeCompare(b[1]);
      return a[0].localeCompare(b[0]);
    });
    parsed.search = "";
    for (const [key, val] of sortedParams) {
      parsed.searchParams.append(key, val);
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

/**
 * 並行実行ユーティリティ
 *
 * このファイルを用意した理由:
 * - upload/archive の両方で使う上限付き並列実行ロジックを1箇所に集約するため。
 *
 * このファイルが使われる場面:
 * - OneDrive API の getItem 等を複数件並行で呼び出すとき。
 */
export async function mapWithConcurrencyLimit<T, U>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<U>,
): Promise<Array<PromiseSettledResult<U>>> {
  if (items.length === 0) return [];
  const results: Array<PromiseSettledResult<U>> = new Array(items.length);
  const limit = Math.max(1, Math.floor(concurrency));
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      try {
        const value = await worker(items[currentIndex], currentIndex);
        results[currentIndex] = { status: "fulfilled", value };
      } catch (reason) {
        results[currentIndex] = { status: "rejected", reason };
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runWorker());
  await Promise.all(workers);
  return results;
}

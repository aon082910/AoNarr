/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once and returns the results in the order of
 * `items`, so a caller that scored or looked up each item one at a time gets the same list sooner. The first
 * failure rejects (the calls already started finish on their own).
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

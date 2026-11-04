/**
 * Runs `fn` over `items` with at most `limit` calls in flight at once and returns the results in the order of
 * `items`, so a caller that scored or looked up each item one at a time gets the same list sooner. The first
 * failure rejects; the calls already started finish on their own, but no new call is started after it.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  // Set by the first failure so the other workers stop taking items.
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next++;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}

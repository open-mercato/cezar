/**
 * Apply an async operation with bounded parallelism while retaining input order.
 * Callers own per-item error handling; a rejection stops the whole mapping just
 * like Promise.all would, without leaving workers running new items.
 */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('concurrency limit must be a positive integer');

  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
/** Fixed per-request budget for directory-entry filesystem probes. */
export const FILESYSTEM_LISTING_CONCURRENCY = 16;

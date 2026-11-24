/** Map `items` with at most `limit` calls in flight, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  results.length = items.length;
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await map(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

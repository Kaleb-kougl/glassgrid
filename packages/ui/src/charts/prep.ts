import type { ChartColumns } from './types.js';

/*
 * Data-derived structures (bin indexes, edges, extents, colour buckets)
 * depend only on the result, not on the chart's size or theme, so they are
 * computed once per result and reused when a chart is resized or restyled.
 * Keyed weakly by the columns object: a new result gets fresh entries and
 * old ones are collected with it.
 */
const cache = new WeakMap<ChartColumns, Map<string, unknown>>();

export function prepared<T>(data: ChartColumns, key: string, compute: () => T): T {
  let entries = cache.get(data);
  if (!entries) {
    entries = new Map();
    cache.set(data, entries);
  }
  if (!entries.has(key)) entries.set(key, compute());
  return entries.get(key) as T;
}

import { tableFromArrays } from 'apache-arrow';
import { vi } from 'vitest';
import { tableIdForFile, toFileHandle, type FilterInput, type SortKey, type TableHandle } from '@glassgrid/core';
import type { EngineClientLike } from '../engine';

/*
 * An engine double for app tests: three columns (id, category, amount), two
 * rows per page, result tables shaped like the compiler's per mark, every
 * method a vi.fn. `restart()` fires the engine-restarted listeners.
 */

export const handle = toFileHandle('0b6c8f0e-6d0a-4f43-9d3e-2f1f1a0d9c11');
export const tableId = tableIdForFile(handle);
export const table: TableHandle = {
  id: tableId,
  file: handle,
  fileName: 'trips.csv',
  fingerprint: { sizeBytes: 2048, mtimeMs: 1, headTailSha256: 'a'.repeat(64), key: 'b'.repeat(32) },
  usingParquetCache: false,
  columns: [
    { name: 'id', type: 'integer', duckdbType: 'BIGINT' },
    { name: 'category', type: 'text', duckdbType: 'VARCHAR' },
    { name: 'amount', type: 'float', duckdbType: 'DOUBLE' },
  ],
};

interface PageView {
  viewId?: string;
  sort?: SortKey[];
  filters?: readonly FilterInput[];
}

/** Result rows shaped like the compiler's for each mark. */
function aggregateTable(mark: string) {
  const f64 = (values: number[]) => Float64Array.from(values);
  switch (mark) {
    case 'histogram':
      return tableFromArrays({ x: f64([0, 1, 2]), x_end: f64([1, 2, 3]), y: f64([5, 3, 1]) });
    case 'line':
    case 'area':
    case 'scatter':
      return tableFromArrays({ x: f64([0, 1, 2, 3]), y: f64([4, 6, 5, 7]) });
    case 'heatmap':
      return tableFromArrays({ x: f64([0, 1]), x_end: f64([1, 2]), y: f64([0, 0]), y_end: f64([1, 1]), count: f64([3, 4]) });
    default:
      return tableFromArrays({ x: ['alpha', 'bravo'], y: Float64Array.from([7, 5]) });
  }
}

export function fakeEngine() {
  const timing = { engineMs: 1, cached: false };
  const restartListeners = new Set<() => void>();
  /** Every page the grid fetched: view, offset and limit. */
  const pages: { table: string; view: PageView; offset: number; limit: number }[] = [];
  return {
    pages,
    restart: () => restartListeners.forEach((listener) => listener()),
    open: vi.fn(() => Promise.resolve({ table, engineMs: 3 })),
    pageFetcher: vi.fn((tableId: string, view: PageView = {}) => (offset: number, limit: number) => {
      pages.push({ table: tableId, view, offset, limit });
      return Promise.resolve({
        table: tableFromArrays({ id: Int32Array.from([1, 2]), category: ['alpha', null], amount: Float64Array.from([1.5, 2]) }),
        ...timing,
      });
    }),
    setColumnTypes: vi.fn((tableId: string, overrides: readonly { column: string; type: string }[]) =>
      Promise.resolve({
        table: { ...table, id: tableId as TableHandle['id'], typeOverrides: overrides.map((o) => ({ ...o })) } as TableHandle,
        columns: overrides.map((o) => ({ column: o.column, type: o.type as 'text', duckdbType: 'VARCHAR', failedCasts: o.type === 'integer' ? 1_234 : 0 })),
        engineMs: 2,
      }),
    ),
    closeTable: vi.fn(() => Promise.resolve()),
    onRestarted: vi.fn((listener: () => void) => {
      restartListeners.add(listener);
      return () => restartListeners.delete(listener);
    }),
    profile: vi.fn(() =>
      Promise.resolve({
        rowCount: 2,
        columns: table.columns.map((c, i) => ({ ...c, nullFraction: 0, distinctCount: [2, 12_345, 8_410_000][i] ?? 0, min: null, max: null })),
        ...timing,
      }),
    ),
    count: vi.fn((_table: string, options: { filters?: readonly unknown[] } = {}) =>
      Promise.resolve({ rowCount: options.filters?.length ? 1 : 2, ...timing }),
    ),
    aggregate: vi.fn((_table: string, spec: { mark: string }, _options?: unknown) =>
      Promise.resolve({
        table: aggregateTable(spec.mark),
        mark: spec.mark as 'bar',
        fellBackToHeatmap: false,
        fromCube: false,
        ...timing,
      }),
    ),
    prepareCrossfilter: vi.fn(() => Promise.resolve({ cubes: [], engineMs: 1 })),
    onEvent: vi.fn(() => () => undefined),
  } satisfies EngineClientLike & Record<string, unknown>;
}

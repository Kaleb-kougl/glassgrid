import type { ColumnType } from '@glassgrid/core';
import { columnWidthFor, formatDate, formatTimestamp } from './format.js';
import { PagedGridSource, type PageColumns, type PagedSourceOptions } from './PagedGridSource.js';
import type { GridCell, GridColumn } from './types.js';

/** Largest row count a SyntheticSource accepts. */
export const MAX_SYNTHETIC_ROWS = 50_000_000;

export interface SyntheticSourceOptions extends Partial<Omit<PagedSourceOptions, 'columns' | 'rowCount'>> {
  /** Rows, up to 50M (default 1M). */
  readonly rowCount?: number;
  /** Columns (default 12); past the 12 built-in shapes they repeat with a suffix. */
  readonly columnCount?: number;
  /** Artificial latency per page in ms (default 20). */
  readonly latencyMs?: number;
  /** Changes every value (default 1). */
  readonly seed?: number;
}

interface SyntheticColumnShape {
  readonly name: string;
  readonly type: ColumnType;
  readonly value: (row: number, hash: number) => GridCell;
}

const PAYMENT = ['Credit card', 'Cash', 'No charge', 'Dispute', 'Unknown'] as const;
const VENDORS = [
  'Creative Mobile Technologies, LLC',
  'VeriFone Inc.',
  'Curb Mobility "Taxi" Services',
  'Yellow Cab Co-op',
  'Independent operator with an unusually long registered business name',
] as const;
const BASE_MS = Date.UTC(2023, 0, 1);

const cents = (hash: number, max: number) => ((hash % (max * 100)) / 100).toFixed(2);

const SHAPES: readonly SyntheticColumnShape[] = [
  { name: 'id', type: 'integer', value: (row) => String(row + 1) },
  { name: 'pickup_datetime', type: 'timestamp', value: (row, h) => formatTimestamp(BASE_MS + row * 7_000 + (h % 7) * 1_000) },
  { name: 'dropoff_datetime', type: 'timestamp', value: (row, h) => formatTimestamp(BASE_MS + row * 7_000 + 300_000 + (h % 2_700) * 1_000) },
  { name: 'passenger_count', type: 'integer', value: (_, h) => (h % 23 === 0 ? null : String(1 + (h % 6))) },
  { name: 'trip_distance', type: 'float', value: (_, h) => cents(h >>> 3, 30) },
  { name: 'fare_amount', type: 'float', value: (_, h) => cents(h >>> 5, 120) },
  { name: 'tip_amount', type: 'float', value: (_, h) => (h % 11 === 0 ? null : cents(h >>> 7, 25)) },
  { name: 'total_amount', type: 'float', value: (_, h) => cents(h >>> 2, 9_999) },
  { name: 'payment_type', type: 'text', value: (_, h) => PAYMENT[h % PAYMENT.length] ?? null },
  { name: 'vendor_name', type: 'text', value: (_, h) => VENDORS[(h >>> 4) % VENDORS.length] ?? null },
  { name: 'pickup_date', type: 'date', value: (row) => formatDate(BASE_MS + Math.floor((row * 7_000) / 86_400_000) * 86_400_000) },
  { name: 'store_and_fwd', type: 'boolean', value: (_, h) => (h % 31 === 0 ? null : h % 4 === 0 ? 'true' : 'false') },
];

/** A 32-bit integer hash of (row, col, seed): deterministic, well mixed. */
export function syntheticHash(row: number, col: number, seed = 1): number {
  let h = Math.imul(row ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(col + seed * 0x27d4eb2f, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

export function syntheticColumns(count = SHAPES.length): GridColumn[] {
  return Array.from({ length: count }, (_, i) => {
    const shape = SHAPES[i % SHAPES.length] as SyntheticColumnShape;
    const name = i < SHAPES.length ? shape.name : `${shape.name}_${Math.floor(i / SHAPES.length) + 1}`;
    return { name, type: shape.type, width: columnWidthFor(name, shape.type) };
  });
}

/** The value SyntheticSource shows at (row, col): pure, for tests. */
export function syntheticCell(row: number, col: number, seed = 1): GridCell {
  const shape = SHAPES[col % SHAPES.length] as SyntheticColumnShape;
  return shape.value(row, syntheticHash(row, col, seed));
}

/**
 * Deterministic rows for tests, the gallery and the benchmark: up to 50M
 * rows of taxi-like values (ids, timestamps, amounts, NULLs, long text),
 * served through the same paging, LRU and cancellation as the engine-backed
 * source, after an artificial latency.
 */
export class SyntheticSource extends PagedGridSource {
  readonly latencyMs: number;
  readonly seed: number;
  /** Pages generated so far (benchmark diagnostics). */
  pagesServed = 0;

  constructor(options: SyntheticSourceOptions = {}) {
    const rowCount = Math.min(MAX_SYNTHETIC_ROWS, Math.max(0, Math.floor(options.rowCount ?? 1_000_000)));
    super({ ...options, rowCount, columns: syntheticColumns(options.columnCount ?? SHAPES.length) });
    this.latencyMs = options.latencyMs ?? 20;
    this.seed = options.seed ?? 1;
  }

  protected loadPage(offset: number, limit: number, signal: AbortSignal): Promise<PageColumns> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        const columns: GridCell[][] = [];
        for (let c = 0; c < this.columns.length; c += 1) {
          const values = new Array<GridCell>(limit);
          for (let r = 0; r < limit; r += 1) values[r] = syntheticCell(offset + r, c, this.seed);
          columns.push(values);
        }
        this.pagesServed += 1;
        resolve(columns);
      }, this.latencyMs);
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

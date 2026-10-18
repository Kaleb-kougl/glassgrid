import { tableFromArrays, Table, vectorFromArray, TimestampMillisecond, DateDay, Utf8, Float64, Int64, Bool, makeData, makeVector, Field, Schema, RecordBatch, Struct } from 'apache-arrow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArrowPagedSource, tableToColumns } from './ArrowPagedSource.js';
import { filterValue, formatDate, formatInterval, formatTime, formatTimestamp, formatValue } from './format.js';
import { isAbortError, PagedGridSource, type PageColumns, type PagedSourceOptions } from './PagedGridSource.js';
import { MAX_SYNTHETIC_ROWS, syntheticCell, SyntheticSource } from './SyntheticSource.js';
import type { GridCell, GridColumn, GridSourceChange } from './types.js';

const columns: GridColumn[] = [
  { name: 'id', type: 'integer', width: 100 },
  { name: 'name', type: 'text', width: 100 },
];

interface Pending {
  offset: number;
  limit: number;
  signal: AbortSignal;
  resolve: (columns: PageColumns) => void;
  reject: (error: unknown) => void;
}

/** A source whose page requests the test resolves by hand. */
class ManualSource extends PagedGridSource {
  readonly pending: Pending[] = [];
  constructor(options: Partial<PagedSourceOptions> = {}) {
    super({ columns, rowCount: 100_000, now: () => Date.now(), ...options });
  }
  protected loadPage(offset: number, limit: number, signal: AbortSignal): Promise<PageColumns> {
    return new Promise((resolve, reject) => {
      this.pending.push({ offset, limit, signal, resolve, reject });
    });
  }
  /** Resolves the request for `page` with generated values. */
  answer(page: number): void {
    const request = this.pending.find((p) => p.offset === page * this.pageSize && !p.signal.aborted);
    if (!request) throw new Error(`no live request for page ${page}`);
    this.pending.splice(this.pending.indexOf(request), 1);
    const ids: GridCell[] = [];
    const names: GridCell[] = [];
    for (let r = 0; r < request.limit; r += 1) {
      ids.push(String(request.offset + r));
      names.push(r % 10 === 0 ? null : `row ${request.offset + r}`);
    }
    request.resolve([ids, names]);
  }
  requestedPages(): number[] {
    return this.pending.filter((p) => !p.signal.aborted).map((p) => p.offset / this.pageSize);
  }
}

const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => undefined);

describe('PagedGridSource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches the first range at once and returns undefined until it arrives', async () => {
    const source = new ManualSource({ prefetchRows: 0 });
    expect(source.getCell(5, 0)).toBeUndefined();
    source.ensureRange(0, 30);
    expect(source.requestedPages()).toEqual([0]);
    const changes: GridSourceChange[] = [];
    source.subscribe((change) => changes.push(change));
    source.answer(0);
    await flush();
    expect(source.getCell(5, 0)).toBe('5');
    expect(source.getCell(10, 1)).toBeNull();
    expect(source.getCell(11, 1)).toBe('row 11');
    expect(changes).toEqual([{ kind: 'rows', firstRow: 0, lastRow: 999 }]);
  });

  it('coalesces a fast drag into one request for the landing range', () => {
    const source = new ManualSource({ prefetchRows: 0, maxInFlight: 8 });
    source.ensureRange(0, 30); // leading edge: immediate
    for (let row = 1_000; row < 90_000; row += 3_000) {
      vi.advanceTimersByTime(16);
      source.ensureRange(row, row + 30);
    }
    // Still dragging: nothing but page 0 has been asked for.
    expect(source.requestedPages()).toEqual([0]);
    vi.advanceTimersByTime(49);
    expect(source.requestedPages()).toEqual([0]);
    vi.advanceTimersByTime(1);
    // Landed on rows 88,000–88,030: page 0 is stale and cancelled, page 88 requested.
    expect(source.requestedPages()).toEqual([88]);
    expect(source.pending.find((p) => p.offset === 0)?.signal.aborted).toBe(true);
  });

  it('does not refetch while the wanted pages stay the same', () => {
    const source = new ManualSource({ prefetchRows: 0 });
    source.ensureRange(0, 30);
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(16);
      source.ensureRange(i * 10, i * 10 + 30);
    }
    vi.advanceTimersByTime(500);
    expect(source.pending).toHaveLength(1);
  });

  it('keeps at most N requests in flight, nearest the viewport first', async () => {
    const source = new ManualSource({ prefetchRows: 0, maxInFlight: 2 });
    source.ensureRange(5_500, 9_500); // pages 5..9, centre page 7
    expect(source.requestedPages().sort()).toEqual([6, 7]);
    source.answer(7);
    await flush();
    expect(source.requestedPages()).toHaveLength(2);
    expect(source.inFlightPages).toHaveLength(2);
    expect(source.requestedPages()).toContain(6);
  });

  it('prefetches beyond the requested rows', () => {
    const source = new ManualSource({ prefetchRows: 200, maxInFlight: 8 });
    source.ensureRange(1_900, 1_950);
    expect(source.requestedPages().sort()).toEqual([1, 2]);
  });

  it('cancels stale requests through their AbortSignal and ignores late answers', async () => {
    const source = new ManualSource({ prefetchRows: 0 });
    source.ensureRange(0, 30);
    const first = source.pending[0] as Pending;
    vi.advanceTimersByTime(100);
    source.ensureRange(50_000, 50_030);
    expect(first.signal.aborted).toBe(true);
    first.resolve([['late'], ['late']]);
    await flush();
    expect(source.getCell(0, 0)).toBeUndefined();
    expect(source.requestedPages()).toEqual([50]);
  });

  it('keeps an LRU of 50 pages and evicts the least recently shown', async () => {
    const source = new ManualSource({ prefetchRows: 0, maxPages: 50, debounceMs: 0 });
    for (let page = 0; page < 51; page += 1) {
      vi.advanceTimersByTime(10);
      source.ensureRange(page * 1_000, page * 1_000 + 10);
      vi.advanceTimersByTime(10);
      source.answer(page);
      await flush();
      if (page === 30) {
        // Look at page 0 again so it survives.
        source.ensureRange(0, 10);
        vi.advanceTimersByTime(10);
      }
    }
    expect(source.cachedPages).toHaveLength(50);
    expect(source.cachedPages).toContain(0);
    expect(source.cachedPages).not.toContain(1);
    expect(source.getCell(1_000, 0)).toBeUndefined();
    expect(source.getCell(0, 0)).toBe('0');
  });

  it('drops everything on reset and announces it', async () => {
    const source = new ManualSource({ prefetchRows: 0 });
    source.ensureRange(0, 10);
    source.answer(0);
    await flush();
    vi.advanceTimersByTime(100);
    source.ensureRange(5_000, 5_010);
    const inFlight = source.pending[0] as Pending;
    const changes: GridSourceChange[] = [];
    source.subscribe((change) => changes.push(change));
    source.reset({ rowCount: 42 });
    expect(inFlight.signal.aborted).toBe(true);
    expect(source.getCell(0, 0)).toBeUndefined();
    expect(source.cachedPages).toEqual([]);
    expect(source.rowCount).toBe(42);
    expect(changes).toEqual([{ kind: 'reset' }]);
    // The next request goes out at once (no debounce carried over).
    source.ensureRange(0, 10);
    expect(source.requestedPages()).toEqual([0]);
  });

  it('changes the row count without dropping pages', async () => {
    const source = new ManualSource({ prefetchRows: 0, rowCount: 1_000 });
    source.ensureRange(0, 10);
    source.answer(0);
    await flush();
    const changes: GridSourceChange[] = [];
    source.subscribe((change) => changes.push(change));
    source.setRowCount(5_000);
    expect(changes).toEqual([{ kind: 'resize' }]);
    expect(source.getCell(3, 0)).toBe('3');
  });

  it('reports errors and retries after the retry delay', async () => {
    const source = new ManualSource({ prefetchRows: 0, retryMs: 1_000 });
    const changes: GridSourceChange[] = [];
    source.subscribe((change) => changes.push(change));
    source.ensureRange(0, 10);
    (source.pending.shift() as Pending).reject(new Error('engine down'));
    await flush();
    await flush();
    expect(changes[0]).toMatchObject({ kind: 'error', firstRow: 0, lastRow: 999 });
    source.ensureRange(0, 10);
    expect(source.pending).toHaveLength(0);
    vi.advanceTimersByTime(1_000);
    source.ensureRange(0, 11);
    vi.advanceTimersByTime(60);
    expect(source.requestedPages()).toEqual([0]);
  });

  it('loads a range for copy, pinned against cancellation', async () => {
    const source = new ManualSource({ prefetchRows: 0, maxInFlight: 1 });
    const loaded = source.loadRange(0, 2_500);
    expect(source.requestedPages().sort()).toEqual([0, 1, 2]);
    // Scrolling elsewhere does not cancel pinned pages.
    vi.advanceTimersByTime(100);
    source.ensureRange(40_000, 40_010);
    vi.advanceTimersByTime(100);
    expect(source.pending.filter((p) => p.offset < 3_000).every((p) => !p.signal.aborted)).toBe(true);
    let done = false;
    void loaded.then(() => {
      done = true;
    });
    source.answer(0);
    source.answer(1);
    await flush();
    expect(done).toBe(false);
    source.answer(2);
    await flush();
    await flush();
    expect(done).toBe(true);
    expect(source.getCell(2_500, 0)).toBe('2500');
  });

  it('rejects a pinned load when its signal aborts, then cancels pages nobody wants', async () => {
    const source = new ManualSource({ prefetchRows: 0 });
    const abort = new AbortController();
    const loaded = source.loadRange(10_000, 10_010, abort.signal);
    const request = source.pending[0] as Pending;
    abort.abort();
    await expect(loaded).rejects.toSatisfy(isAbortError);
    expect(request.signal.aborted).toBe(true);
  });
});

describe('formatting', () => {
  it('formats dates and timestamps like DuckDB, in UTC', () => {
    const ms = Date.UTC(2023, 0, 1, 0, 2, 14);
    expect(formatDate(ms)).toBe('2023-01-01');
    expect(formatTimestamp(ms)).toBe('2023-01-01 00:02:14');
    expect(formatTimestamp(ms + 0.5)).toBe('2023-01-01 00:02:14.0005');
    expect(formatTimestamp(ms + 123.456)).toBe('2023-01-01 00:02:14.123456');
  });

  it('formats raw values per kind', () => {
    expect(formatValue(null, 'other')).toBeNull();
    expect(formatValue(undefined, 'other')).toBeNull();
    expect(formatValue(3.25, 'other')).toBe('3.25');
    expect(formatValue(12345678901234567890n, 'other')).toBe('12345678901234567890');
    expect(formatValue(true, 'other')).toBe('true');
    expect(formatValue('x', 'timestamp')).toBe('x');
    expect(formatValue(Date.UTC(2026, 1, 2), 'date')).toBe('2026-02-02');
    expect(formatValue(new Date(Date.UTC(2026, 1, 2, 3, 4, 5)), 'timestamp')).toBe('2026-02-02 03:04:05');
    expect(formatValue(BigInt(Date.UTC(2026, 1, 2)), 'timestamp')).toBe('2026-02-02 00:00:00');
    expect(formatValue({ a: 1n }, 'other')).toBe('{"a":"1"}');
  });
});

describe('Arrow values (DECIMAL, TIME, INTERVAL)', () => {
  // Decimal128 values arrive as four little-endian 32-bit words of the unscaled integer.
  const words = (unscaled: bigint) => {
    const u = BigInt.asUintN(128, unscaled);
    return new Uint32Array([0, 1, 2, 3].map((i) => Number((u >> BigInt(32 * i)) & 0xffffffffn)));
  };

  it('formats dates, timestamps and big integers', () => {
    expect(formatValue(1_728_000_000_000, 'date')).toBe('2024-10-04');
    expect(formatTimestamp(1_700_000_000_123.456)).toBe('2023-11-14 22:13:20.123456');
    expect(formatValue(42n, 'other')).toBe('42');
    expect(formatValue(null, 'other')).toBeNull();
  });

  it('formats decimals exactly, including negative 128-bit values', () => {
    expect(formatValue(words(12_345n), 'decimal:2')).toBe('123.45');
    expect(formatValue(words(-5n), 'decimal:3')).toBe('-0.005');
    expect(formatValue(words(-(10n ** 37n) + 1n), 'decimal:0')).toBe('-9999999999999999999999999999999999999');
    expect(formatValue(words(0n), 'decimal:2')).toBe('0.00');
    expect(formatValue(null, 'decimal:2')).toBeNull();
  });

  it('formats times and intervals like DuckDB', () => {
    expect(formatTime(45_296_789_000n)).toBe('12:34:56.789');
    expect(formatValue(45_296_000_000_001n, 'timeNs')).toBe('12:34:56.000000001');
    expect(formatValue(45_296_789_000n, 'time')).toBe('12:34:56.789');
    expect(formatInterval(new Int32Array([14, 3, 0, 0]))).toBe('1 year 2 months 3 days');
    expect(formatInterval(new Int32Array([-1, -1, -1_000_000_000, -1]))).toBe('-1 month -1 day -00:00:01');
    expect(formatInterval(new Int32Array([0, 0, 0, 0]))).toBe('00:00:00');
    expect(formatValue(new Int32Array([0, 1, 0, 0]), 'interval')).toBe('1 day');
  });

  it('turns values into filter values the compiler accepts', () => {
    expect(filterValue(words(150n), 'decimal:2')).toBe(1.5);
    expect(filterValue(1_728_000_000_000, 'date')).toBe(1_728_000_000_000);
    expect(filterValue(1_700_000_000_123.5, 'timestamp')).toBe('2023-11-14 22:13:20.1235');
    expect(filterValue(7n, 'other')).toBe(7);
    expect(filterValue(45_296_789_000n, 'time')).toBe('12:34:56.789');
    expect(filterValue(undefined, 'other')).toBeNull();
  });
});

describe('ArrowPagedSource', () => {
  function arrowTable(offset: number, limit: number): Table {
    const ts = Array.from({ length: limit }, (_, i) => Date.UTC(2023, 0, 1) + (offset + i) * 1_000);
    const schema = new Schema([
      new Field('id', new Int64(), true),
      new Field('name', new Utf8(), true),
      new Field('amount', new Float64(), true),
      new Field('at', new TimestampMillisecond(), true),
      new Field('day', new DateDay(), true),
      new Field('ok', new Bool(), true),
    ]);
    const children = [
      vectorFromArray(
        Array.from({ length: limit }, (_, i) => BigInt(offset + i)),
        new Int64(),
      ),
      vectorFromArray(
        Array.from({ length: limit }, (_, i) => (i === 1 ? null : `n${offset + i}`)),
        new Utf8(),
      ),
      vectorFromArray(
        Array.from({ length: limit }, (_, i) => (i === 2 ? null : (offset + i) / 4)),
        new Float64(),
      ),
      vectorFromArray(ts, new TimestampMillisecond()),
      vectorFromArray(
        ts.map((t) => new Date(t)),
        new DateDay(),
      ),
      vectorFromArray(
        Array.from({ length: limit }, (_, i) => i % 2 === 0),
        new Bool(),
      ),
    ];
    const struct = makeData({
      type: new Struct(schema.fields),
      length: limit,
      nullCount: 0,
      children: children.map((vector) => vector.data[0] as NonNullable<(typeof vector.data)[0]>),
    });
    return new Table(schema, new RecordBatch(schema, struct));
  }

  const arrowColumns: GridColumn[] = [
    { name: 'day', type: 'date', width: 100 },
    { name: 'id', type: 'integer', width: 100 },
    { name: 'name', type: 'text', width: 100 },
    { name: 'amount', type: 'float', width: 100 },
    { name: 'at', type: 'timestamp', width: 100 },
    { name: 'ok', type: 'boolean', width: 100 },
    { name: 'missing', type: 'text', width: 100 },
  ];

  it('formats an Arrow page by column name and logical type', () => {
    const table = arrowTable(1_000, 4);
    const page = tableToColumns(table, arrowColumns, 4);
    expect(page[0]?.[0]).toBe('2023-01-01');
    expect(page[1]).toEqual(['1000', '1001', '1002', '1003']);
    expect(page[2]?.[1]).toBeNull();
    expect(page[3]?.[0]).toBe('250');
    expect(page[3]?.[2]).toBeNull();
    expect(page[4]?.[3]).toBe('2023-01-01 00:16:43');
    expect(page[5]).toEqual(['true', 'false', 'true', 'false']);
    expect(page[6]).toEqual([null, null, null, null]);
  });

  it('pages through fetchPage with offsets, limits and signals', async () => {
    const calls: [number, number, AbortSignal][] = [];
    const source = new ArrowPagedSource({
      columns: arrowColumns.slice(1, 3),
      rowCount: 2_500,
      prefetchRows: 0,
      fetchPage: (offset, limit, signal) => {
        calls.push([offset, limit, signal]);
        return Promise.resolve(arrowTable(offset, limit));
      },
    });
    await source.loadRange(1_990, 2_499);
    expect(calls.map(([offset, limit]) => [offset, limit])).toEqual([
      [1_000, 1_000],
      [2_000, 500],
    ]);
    expect(source.getCell(1_990, 0)).toBe('1990');
    expect(source.getCell(2_499, 1)).toBe('n2499');
    expect(source.getCell(2_001, 1)).toBeNull();
    expect(calls[0]?.[2]).toBeInstanceOf(AbortSignal);
  });

  it('builds a table from plain arrays too', () => {
    const table = tableFromArrays({ id: Int32Array.from([1, 2]), name: ['a', 'b'] });
    expect(tableToColumns(table, columns, 2)).toEqual([
      ['1', '2'],
      ['a', 'b'],
    ]);
    // Unknown names with matching shape fall back to position.
    const renamed = tableFromArrays({ x: Int32Array.from([7]), y: ['z'] });
    expect(tableToColumns(renamed, columns, 1)).toEqual([['7'], ['z']]);
    expect(makeVector(Int32Array.from([1])).length).toBe(1);
  });
});

describe('SyntheticSource', () => {
  it('is deterministic and serves pages after its latency', async () => {
    vi.useFakeTimers();
    try {
      const source = new SyntheticSource({ rowCount: 50_000_000, latencyMs: 30, prefetchRows: 0 });
      expect(source.columns).toHaveLength(12);
      expect(source.rowCount).toBe(50_000_000);
      source.ensureRange(49_999_990, 49_999_999);
      vi.advanceTimersByTime(29);
      expect(source.getCell(49_999_999, 0)).toBeUndefined();
      vi.advanceTimersByTime(1);
      await flush();
      expect(source.getCell(49_999_999, 0)).toBe('50000000');
      for (let col = 0; col < 12; col += 1) expect(source.getCell(49_999_995, col)).toBe(syntheticCell(49_999_995, col));
      expect(syntheticCell(123, 4)).toBe(syntheticCell(123, 4));
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the row count and repeats column shapes past 12', () => {
    expect(new SyntheticSource({ rowCount: 1e12 }).rowCount).toBe(MAX_SYNTHETIC_ROWS);
    const wide = new SyntheticSource({ columnCount: 14 });
    expect(wide.columns.map((c) => c.name).slice(12)).toEqual(['id_2', 'pickup_datetime_2']);
  });

  it('includes nulls and long text', () => {
    const values = Array.from({ length: 200 }, (_, row) => syntheticCell(row, 3));
    expect(values).toContain(null);
    const vendors = new Set(Array.from({ length: 200 }, (_, row) => syntheticCell(row, 9)));
    expect([...vendors].some((v) => (v ?? '').length > 40)).toBe(true);
  });
});

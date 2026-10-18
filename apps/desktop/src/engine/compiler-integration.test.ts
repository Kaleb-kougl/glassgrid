/*
 * The core SQL compiler wired into the engine: filters on rows/count and
 * chart aggregates for every mark, through EngineSession (request parsing,
 * compilation, QueryService, Arrow encoding) against real DuckDB. Expected
 * values come from plain JS over the generated fixture rows.
 */
import { join } from 'node:path';
import type { Table } from 'apache-arrow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileChartQuery, type AggregateResult, type EngineReply, type EngineRequest, type EngineResponse, type FilterInput, type TableId } from '@glassgrid/core';
import { EngineSession } from './session';
import { CATEGORIES, columnValues, createHarness, decode, fixtureRow, writeFixtureCsv, writeLines, type Harness } from './test-support';

/** Large enough for several 1,000-row pages after filtering, small enough to stay fast. */
const ROWS = 20_000;
const rows = Array.from({ length: ROWS }, (_, i) => fixtureRow(i));

let h: Harness;
let csvTable: TableId;
let parquetTable: TableId;
/** `at` (TIMESTAMP) on both sides of the epoch, with seconds; `v` a small number. */
let stampsTable: TableId;
const STAMPS_START = Date.UTC(1969, 11, 30, 21, 17, 3);
const stamps = Array.from({ length: 3_000 }, (_, i) => STAMPS_START + i * 97_000);
let session: EngineSession;
const sent: EngineResponse[] = [];
let nextId = 0;
let nextSeq = 0;

beforeAll(async () => {
  h = await createHarness();
  const path = join(h.dir, 'compiler.csv');
  await writeFixtureCsv(path, ROWS);
  const csv = h.register(path);
  const parquet = h.register(path);
  csvTable = csv.table;
  parquetTable = parquet.table;
  session = new EngineSession(Promise.resolve(h.service), (message) => sent.push(message));
  await request({ kind: 'open', file: csv.file, parquet: 'never' });
  await request({ kind: 'open', file: parquet.file, parquet: 'never' });
  await h.service.ensureParquetCache(parquetTable);
  const stampsPath = join(h.dir, 'stamps.csv');
  await writeLines(stampsPath, 'at,v', stamps.map((ms, i) => `${new Date(ms).toISOString().replace('T', ' ').replace('.000Z', '')},${i % 7}`));
  const stamped = h.register(stampsPath);
  stampsTable = stamped.table;
  await request({ kind: 'open', file: stamped.file, parquet: 'always' });
  await h.service.ensureParquetCache(stampsTable);
});

afterAll(async () => {
  session.dispose();
  await h.dispose();
});

type Body = EngineRequest extends infer R ? (R extends EngineRequest ? Omit<R, 'requestId'> : never) : never;

async function request(body: Body | Record<string, unknown>): Promise<EngineReply> {
  nextId += 1;
  const requestId = `t${nextId}`;
  session.handle({ ...body, requestId });
  const deadline = Date.now() + 60_000;
  for (;;) {
    const found = sent.find((m): m is EngineReply => m.kind !== 'event' && m.requestId === requestId);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`No reply to ${requestId}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function view(viewId: string) {
  nextSeq += 1;
  return { viewId, seq: nextSeq };
}

async function count(table: TableId, filters: FilterInput[]): Promise<number> {
  const reply = await request({ kind: 'count', table, ...view('count'), filters });
  if (reply.kind !== 'count') throw new Error(`Expected count, got ${JSON.stringify(reply)}`);
  return reply.rowCount;
}

async function pageIds(
  table: TableId,
  filters: FilterInput[],
  offset: number,
  limit: number,
  sort?: Array<{ column: string; direction: 'asc' | 'desc' }>,
): Promise<number[]> {
  const query = { offset, limit, ...(sort ? { sort } : {}) };
  const reply = await request({ kind: 'rows', table, ...view('grid'), query, filters });
  if (reply.kind !== 'arrow') throw new Error(`Expected arrow, got ${JSON.stringify(reply)}`);
  return columnValues(decode(reply.ipc), 'id') as number[];
}

async function aggregate(spec: Record<string, unknown>, table: TableId = csvTable): Promise<AggregateResult & { table: Table }> {
  const reply = await request({ kind: 'aggregate', table, ...view('chart:test'), spec });
  if (reply.kind !== 'aggregate') throw new Error(`Expected aggregate, got ${JSON.stringify(reply)}`);
  return { ...reply, table: decode(reply.ipc) };
}

const numbers = (table: Table, name: string) => columnValues(table, name).map((value) => Number(value));
const midnight = (date: string) => Date.parse(`${date}T00:00:00Z`);

// ---------------------------------------------------------------------------

type Row = (typeof rows)[number];

interface FilterCase {
  name: string;
  filters: FilterInput[];
  matches: (row: Row) => boolean;
}

const FILTER_CASES: FilterCase[] = [
  {
    name: 'numeric range with an exclusive max',
    filters: [{ kind: 'range', column: 'amount', min: 1000, max: 5000, maxInclusive: false }],
    matches: (r) => r.amount >= 1000 && r.amount < 5000,
  },
  {
    name: 'set membership, including a value that never occurs and null',
    filters: [{ kind: 'in', column: 'category', values: ['alpha', 'charlie', 'zulu', null] }],
    matches: (r) => r.category === 'alpha' || r.category === 'charlie',
  },
  {
    name: 'date range given as ISO strings',
    filters: [{ kind: 'range', column: 'created_on', min: '2026-03-01', max: '2026-05-15' }],
    matches: (r) => midnight(r.createdOn) >= midnight('2026-03-01') && midnight(r.createdOn) <= midnight('2026-05-15'),
  },
  {
    name: 'four filters at once ($1..$n placeholders next to literal offsets)',
    filters: [
      { kind: 'range', column: 'amount', min: 500, minInclusive: false },
      { kind: 'in', column: 'category', values: ['bravo', 'delta', 'echo'] },
      { kind: 'range', column: 'id', max: 15_000 },
      { kind: 'notNull', column: 'created_on' },
    ],
    matches: (r) => r.amount > 500 && ['bravo', 'delta', 'echo'].includes(r.category) && r.id <= 15_000,
  },
  {
    name: 'an empty set (matches nothing)',
    filters: [{ kind: 'in', column: 'category', values: [] }],
    matches: () => false,
  },
  {
    name: 'isNull on a column without NULLs',
    filters: [{ kind: 'isNull', column: 'amount' }],
    matches: () => false,
  },
];

describe.each([
  ['CSV', () => csvTable],
  ['Parquet', () => parquetTable],
])('filtered rows and count (%s)', (_label, tableOf) => {
  it.each(FILTER_CASES)('$name', async ({ filters, matches }) => {
    const table = tableOf();
    const expected = rows.filter(matches);
    expect(await count(table, filters)).toBe(expected.length);

    // Unsorted: matching rows in file order, paged by literal offsets.
    const expectedIds = expected.map((r) => r.id);
    expect(await pageIds(table, filters, 0, 1000)).toEqual(expectedIds.slice(0, 1000));
    expect(await pageIds(table, filters, 1500, 700)).toEqual(expectedIds.slice(1500, 2200));

    // Sorted: amount descending, ties in file order.
    const sorted = [...expected].sort((a, b) => b.amount - a.amount || a.id - b.id).map((r) => r.id);
    const sort = [{ column: 'amount', direction: 'desc' as const }];
    expect(await pageIds(table, filters, 0, 1000, sort)).toEqual(sorted.slice(0, 1000));
    expect(await pageIds(table, filters, 2000, 500, sort)).toEqual(sorted.slice(2000, 2500));
  });
});

describe('filtered count caching', () => {
  it('caches per filter set and keeps the unfiltered count separate', async () => {
    const filters: FilterInput[] = [{ kind: 'in', column: 'category', values: ['echo'] }];
    const first = await request({ kind: 'count', table: csvTable, ...view('cache'), filters });
    const again = await request({ kind: 'count', table: csvTable, ...view('cache'), filters });
    const all = await request({ kind: 'count', table: csvTable, ...view('cache') });
    expect(first).toMatchObject({ kind: 'count', rowCount: ROWS / CATEGORIES.length });
    expect(again).toMatchObject({ kind: 'count', rowCount: ROWS / CATEGORIES.length, cached: true });
    expect(all).toMatchObject({ kind: 'count', rowCount: ROWS });
  });
});

// ---------------------------------------------------------------------------

describe('aggregate', () => {
  it('bar: top categories by sum, descending', async () => {
    const result = await aggregate({ mark: 'bar', x: { column: 'category' }, y: { column: 'amount', aggregate: 'sum' } });
    const sums = new Map<string, number>();
    for (const r of rows) sums.set(r.category, (sums.get(r.category) ?? 0) + r.amount);
    const expected = [...sums].sort((a, b) => b[1] - a[1]);
    expect(result).toMatchObject({ mark: 'bar', fellBackToHeatmap: false, cached: false });
    expect(columnValues(result.table, 'x')).toEqual(expected.map(([category]) => category));
    numbers(result.table, 'y').forEach((y, i) => expect(y).toBeCloseTo(expected[i]?.[1] ?? NaN, 6));
  });

  it('bar: applies spec filters and limit, and serves repeats from the cache', async () => {
    const spec = {
      mark: 'bar',
      x: { column: 'category' },
      filters: [{ kind: 'range', column: 'amount', max: 100 }],
      limit: 2,
    };
    const result = await aggregate(spec);
    const counts = new Map<string, number>();
    for (const r of rows) if (r.amount <= 100) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
    const expected = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2);
    expect(columnValues(result.table, 'x')).toEqual(expected.map(([category]) => category));
    expect(numbers(result.table, 'y')).toEqual(expected.map(([, n]) => n));
    expect((await aggregate(spec)).cached).toBe(true);
  });

  it('histogram: fixed-width bins with x_end', async () => {
    const result = await aggregate({ mark: 'histogram', x: { column: 'amount', bin: 1000 } });
    const counts = new Map<number, number>();
    for (const r of rows) counts.set(Math.floor(r.amount / 1000), (counts.get(Math.floor(r.amount / 1000)) ?? 0) + 1);
    const bins = [...counts].sort((a, b) => a[0] - b[0]);
    expect(result.mark).toBe('histogram');
    expect(numbers(result.table, 'x')).toEqual(bins.map(([k]) => k * 1000));
    expect(numbers(result.table, 'x_end')).toEqual(bins.map(([k]) => (k + 1) * 1000));
    expect(numbers(result.table, 'y')).toEqual(bins.map(([, n]) => n));
  });

  it('line: monthly average over a date column', async () => {
    const result = await aggregate({
      mark: 'line',
      x: { column: 'created_on', timeUnit: 'month' },
      y: { column: 'amount', aggregate: 'avg' },
    });
    const groups = new Map<string, number[]>();
    for (const r of rows) {
      const month = `${r.createdOn.slice(0, 7)}-01`;
      groups.set(month, [...(groups.get(month) ?? []), r.amount]);
    }
    const expected = [...groups].sort((a, b) => a[0].localeCompare(b[0]));
    expect(numbers(result.table, 'x')).toEqual(expected.map(([month]) => midnight(month)));
    numbers(result.table, 'y').forEach((y, i) => {
      const values = expected[i]?.[1] ?? [];
      expect(y).toBeCloseTo(values.reduce((a, b) => a + b, 0) / values.length, 6);
    });
  });

  it('area: M4 keeps at most 4 points per pixel column, including the extremes', async () => {
    const pixelWidth = 10;
    const spec = { mark: 'area', x: { column: 'id' }, y: { column: 'amount', aggregate: 'sum' }, pixelWidth };
    const result = await aggregate(spec);
    expect(result.mark).toBe('area');
    expect(result.table.numRows).toBeGreaterThan(0);
    expect(result.table.numRows).toBeLessThanOrEqual(4 * pixelWidth);
    const xs = numbers(result.table, 'x');
    const ys = numbers(result.table, 'y');
    expect(Math.min(...xs)).toBe(1);
    expect(Math.max(...xs)).toBe(ROWS);
    expect(Math.max(...ys)).toBeCloseTo(Math.max(...rows.map((r) => r.amount)), 6);
    expect(Math.min(...ys)).toBeCloseTo(Math.min(...rows.map((r) => r.amount)), 6);

    // pixelWidth is part of the cache key: a wider plot is a different result.
    expect((await aggregate(spec)).cached).toBe(true);
    const wider = await aggregate({ ...spec, pixelWidth: 20 });
    expect(wider.cached).toBe(false);
    expect(wider.table.numRows).toBeGreaterThan(result.table.numRows);
  });

  it('heatmap: 2-D bins whose counts add up to the row count', async () => {
    const result = await aggregate({ mark: 'heatmap', x: { column: 'amount' }, y: { column: 'id' } });
    expect(result.mark).toBe('heatmap');
    // Auto widths are nice numbers >= range / 100, so an axis can straddle one extra bin.
    expect(result.table.numRows).toBeLessThanOrEqual(101 * 101);
    expect(numbers(result.table, 'count').reduce((a, b) => a + b, 0)).toBe(ROWS);
    for (const name of ['x', 'x_end', 'y', 'y_end']) expect(result.table.getChild(name)).not.toBeNull();
  });

  it('scatter: raw points when under the point limit', async () => {
    const filters = [{ kind: 'range', column: 'id', max: 3000 }];
    const result = await aggregate({ mark: 'scatter', x: { column: 'id' }, y: { column: 'amount' }, filters });
    expect(result).toMatchObject({ mark: 'scatter', fellBackToHeatmap: false });
    expect(result.table.numRows).toBe(3000);
    expect(numbers(result.table, 'x').sort((a, b) => a - b)).toEqual(rows.slice(0, 3000).map((r) => r.id));
  });

  it('scatter: falls back to a heatmap above the point limit', async () => {
    const result = await aggregate({ mark: 'scatter', x: { column: 'id' }, y: { column: 'amount' }, limit: 5000 });
    expect(result).toMatchObject({ mark: 'heatmap', fellBackToHeatmap: true });
    expect(numbers(result.table, 'count').reduce((a, b) => a + b, 0)).toBe(ROWS);
  });

  it('runs on the Parquet-backed view too', async () => {
    const result = await aggregate({ mark: 'bar', x: { column: 'category' } }, parquetTable);
    expect(numbers(result.table, 'y')).toEqual(CATEGORIES.map(() => ROWS / CATEGORIES.length));
  });

  it('hour and day buckets of a TIMESTAMP column (integer keys) match UTC buckets on both sides of the epoch', async () => {
    // The engine's profile carries DuckDB types, so the compiler keys these buckets on integers.
    const profile = await request({ kind: 'profile', table: stampsTable, ...view('profile') });
    if (profile.kind !== 'profile') throw new Error(`Expected profile, got ${JSON.stringify(profile)}`);
    expect(profile.columns.find((column) => column.name === 'at')).toMatchObject({ type: 'timestamp', duckdbType: 'TIMESTAMP' });
    expect(compileChartQuery('"t"', { mark: 'line', x: { column: 'at', timeUnit: 'hour' } }, profile.columns).sql).toContain('// 3600000000');

    for (const [unit, size] of [
      ['hour', 3_600_000],
      ['day', 86_400_000],
    ] as const) {
      const counts = new Map<number, number>();
      for (const ms of stamps) counts.set(Math.floor(ms / size) * size, (counts.get(Math.floor(ms / size) * size) ?? 0) + 1);
      const buckets = [...counts].sort((a, b) => a[0] - b[0]);
      expect(buckets[0]?.[0]).toBeLessThan(0);

      const histogram = await aggregate({ mark: 'histogram', x: { column: 'at', timeUnit: unit } }, stampsTable);
      expect(numbers(histogram.table, 'x')).toEqual(buckets.map(([start]) => start));
      expect(numbers(histogram.table, 'x_end')).toEqual(buckets.map(([start]) => start + size));
      expect(numbers(histogram.table, 'y')).toEqual(buckets.map(([, n]) => n));

      // Wide enough that M4 keeps every bucket.
      const line = await aggregate({ mark: 'line', x: { column: 'at', timeUnit: unit }, pixelWidth: 16_384 }, stampsTable);
      expect(numbers(line.table, 'x')).toEqual(buckets.map(([start]) => start));
      expect(numbers(line.table, 'y')).toEqual(buckets.map(([, n]) => n));
    }
  });

  it('maps compiler errors to bad_request with the offending path', async () => {
    const reply = await request({
      kind: 'aggregate',
      table: csvTable,
      ...view('chart:bad'),
      spec: { mark: 'bar', x: { column: 'category' }, y: { column: 'category', aggregate: 'sum' } },
    });
    expect(reply).toMatchObject({ kind: 'error', code: 'bad_request', path: 'y.aggregate' });
    if (reply.kind === 'error') expect(reply.message).toMatch(/count/);
  });
});

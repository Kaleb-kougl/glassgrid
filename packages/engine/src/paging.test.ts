import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compileWhere,
  tableIdForFile,
  toFileHandle,
  type FileHandle,
  type Filter,
  type SortKey,
  type TableId,
} from '@glassgrid/core';
import { QueryService, type PagingStrategy, type RowsOptions } from './query-service';
import { toFragment } from './session';
import { columnValues, createHarness, decode, fixtureRow, hasParquet, latencyBudget, testDriver, writeFixtureCsv, type Harness } from './test-support';

/*
 * Sorted and filtered pages come from two paths: a top-K query (block of the
 * first rows) while the row-number index builds, and the index afterwards.
 * They must return identical rows. Three services over the same files force
 * each path; the property test compares them (and a JS reference for the
 * order) on random tables, sorts, filters and pages.
 */

let h: Harness;
const services: Record<PagingStrategy, QueryService> = {} as Record<PagingStrategy, QueryService>;

beforeAll(async () => {
  h = await createHarness();
  services.auto = await QueryService.create(await testDriver(), { cacheDir: h.cacheDir, topKRows: 40 });
  services.topK = await QueryService.create(await testDriver(), { cacheDir: h.cacheDir, pagingStrategy: 'topK' });
  services.index = await QueryService.create(await testDriver(), { cacheDir: h.cacheDir, pagingStrategy: 'index' });
});

afterAll(async () => {
  for (const service of Object.values(services)) service.close();
  await h.dispose();
});

interface RandomRow {
  a: number | null;
  b: string | null;
  c: number | null;
  d: string | null;
}

const rowArb: fc.Arbitrary<RandomRow> = fc.record({
  a: fc.option(fc.integer({ min: -3, max: 3 }), { freq: 5 }),
  b: fc.option(fc.constantFrom('x', 'y', 'z', 'zz'), { freq: 5 }),
  // k/8 keeps doubles exact through CSV text.
  c: fc.option(fc.integer({ min: -16, max: 16 }).map((k) => k / 8), { freq: 5 }),
  d: fc.option(fc.constantFrom('2024-01-01', '2024-02-29', '2025-12-31'), { freq: 5 }),
});

const sortArb: fc.Arbitrary<SortKey[]> = fc.uniqueArray(
  fc.record({ column: fc.constantFrom('a', 'b', 'c', 'd'), direction: fc.constantFrom('asc' as const, 'desc' as const) }),
  { selector: (key) => key.column, maxLength: 3 },
);

const filterArb: fc.Arbitrary<Filter[]> = fc.array(
  fc.oneof(
    fc.record({ kind: fc.constant('in' as const), column: fc.constant('b'), values: fc.subarray(['x', 'y', 'zz', null]) }),
    fc.record({
      kind: fc.constant('range' as const),
      column: fc.constant('a'),
      min: fc.integer({ min: -3, max: 1 }),
      minInclusive: fc.boolean(),
      maxInclusive: fc.constant(true),
    }),
    fc.record({ kind: fc.constant('notNull' as const), column: fc.constantFrom('c', 'd') }),
  ),
  { maxLength: 2 },
);

function csvCell(value: string | number | null): string {
  return value === null ? '' : String(value);
}

async function writeRandomCsv(rows: readonly RandomRow[]): Promise<string> {
  const path = join(h.dir, `random-${randomUUID()}.csv`);
  // A typed sentinel row at the end (id -1) makes DuckDB sniff the same types for every table.
  const lines = ['id,a,b,c,d', ...rows.map((row, i) => [i, row.a, row.b, row.c, row.d].map(csvCell).join(','))];
  lines.push('-1,0,w,0.5,2000-01-01');
  await writeFile(path, `${lines.join('\n')}\n`);
  return path;
}

async function openEverywhere(path: string, parquet: boolean): Promise<{ file: FileHandle; table: TableId }> {
  const file = toFileHandle(randomUUID());
  for (const service of Object.values(services)) {
    service.registerFile(file, path);
    await service.open(file, { parquet: parquet ? 'always' : 'never' });
    if (parquet) await service.ensureParquetCache(tableIdForFile(file));
  }
  return { file, table: tableIdForFile(file) };
}

async function pageIds(service: QueryService, table: TableId, query: RowsOptions): Promise<number[]> {
  const { value } = await service.rows(table, query, { viewId: 'grid' });
  return columnValues(decode(value), 'id') as number[];
}

type Located = RandomRow & { id: number; position: number };

/** Sort keys then file position, NULLs last in both directions. */
function referenceOrder(rows: readonly Located[], sort: readonly SortKey[]): number[] {
  const compare = (x: Located, y: Located): number => {
    for (const key of sort) {
      const a = x[key.column as keyof RandomRow];
      const b = y[key.column as keyof RandomRow];
      if (a === b) continue;
      if (a === null) return 1;
      if (b === null) return -1;
      const order = a < b ? -1 : 1;
      return key.direction === 'asc' ? order : -order;
    }
    return x.position - y.position;
  };
  return [...rows].sort(compare).map((row) => row.id);
}

describe('top-K and row-number index paths', () => {
  it('return identical pages for random tables, sorts, filters and offsets (CSV and Parquet)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(rowArb, { minLength: 0, maxLength: 120 }),
        sortArb,
        filterArb,
        fc.integer({ min: 0, max: 130 }),
        fc.integer({ min: 1, max: 60 }),
        hasParquet ? fc.boolean() : fc.constant(false),
        async (rows, sort, filters, offset, limit, parquet) => {
          const path = await writeRandomCsv(rows);
          const { table } = await openEverywhere(path, parquet);
          try {
            const columns = await services.index.columns(table);
            const where = filters.length > 0 ? toFragment(compileWhere(filters, columns)) : undefined;
            const query: RowsOptions = { offset, limit, ...(sort.length > 0 ? { sort } : {}), ...(where ? { where } : {}) };
            const viaIndex = await pageIds(services.index, table, query);
            const viaTopK = await pageIds(services.topK, table, query);
            // `auto` with a 40-row block: early pages are block slices, later ones wait for the index.
            const viaAuto = await pageIds(services.auto, table, query);
            expect(viaTopK).toEqual(viaIndex);
            expect(viaAuto).toEqual(viaIndex);
            if (!where) {
              const all: Located[] = [
                ...rows.map((row, id) => ({ ...row, id, position: id })),
                { a: 0, b: 'w', c: 0.5, d: '2000-01-01', id: -1, position: rows.length },
              ];
              expect(viaIndex).toEqual(referenceOrder(all, sort).slice(offset, offset + limit));
            }
          } finally {
            for (const service of Object.values(services)) await service.closeTable(table);
          }
        },
      ),
      { numRuns: 60, seed: 20261017, endOnFailure: true },
    );
  });
});

describe('top-K block while the index builds', () => {
  const ROWS = 300_000;
  let file: FileHandle;
  let table: TableId;
  const sort: SortKey[] = [{ column: 'category', direction: 'desc' }];

  beforeAll(async () => {
    const path = join(h.dir, 'block.csv');
    await writeFixtureCsv(path, ROWS);
    ({ file, table } = h.register(path));
    services.index.registerFile(file, path);
    await services.index.open(file, { parquet: 'never' });
  });

  it('serves the first pages from one top-K block and later pages from the index, identically', async () => {
    const service = await h.restart();
    service.registerFile(file, join(h.dir, 'block.csv'));
    await service.open(file, { parquet: 'never' });
    const first = await service.rows(table, { offset: 0, limit: 1000, sort }, { viewId: 'grid' });
    expect(first.cached).toBe(false);
    // Pages inside the block are slices of it: no query, even while the index builds.
    const started = performance.now();
    const second = await service.rows(table, { offset: 1000, limit: 1000, sort }, { viewId: 'grid' });
    expect(performance.now() - started).toBeLessThan(latencyBudget(100));
    expect(service.debugState().sortIndexes).toBe(1);

    const expected = (offset: number) =>
      Array.from({ length: ROWS }, (_, i) => i)
        .sort((x, y) => (fixtureRow(y).category < fixtureRow(x).category ? -1 : fixtureRow(y).category > fixtureRow(x).category ? 1 : x - y))
        .slice(offset, offset + 1000)
        .map((i) => i + 1);
    expect(columnValues(decode(first.value), 'id')).toEqual(expected(0));
    expect(columnValues(decode(second.value), 'id')).toEqual(expected(1000));

    // A deep page waits for the index; pages past the block compare equal to the forced-index service.
    for (const offset of [4000, 4500, 150_000, ROWS - 1000]) {
      const auto = await service.rows(table, { offset, limit: 1000, sort }, { viewId: 'grid' });
      const index = await services.index.rows(table, { offset, limit: 1000, sort });
      expect(columnValues(decode(auto.value), 'id')).toEqual(columnValues(decode(index.value), 'id'));
    }
  });

  it('keeps file order for filtered, unsorted pages on a multi-threaded scan', async () => {
    const service = h.service;
    const columns = await services.index.columns(table);
    const where = toFragment(compileWhere([{ kind: 'in', column: 'category', values: ['bravo', 'echo'] }], columns));
    for (const offset of [0, 3000, 4000]) {
      const auto = await service.rows(table, { offset, limit: 1000, where }, { viewId: `f${offset}` });
      const index = await services.index.rows(table, { offset, limit: 1000, where });
      const ids = columnValues(decode(auto.value), 'id') as number[];
      expect(ids).toEqual(columnValues(decode(index.value), 'id'));
      expect(ids[0]).toBe(Math.floor(offset / 2) * 5 + (offset % 2 === 0 ? 2 : 5));
    }
  });

  it('builds no index when every matching row fits in the block', async () => {
    const service = await h.restart();
    service.registerFile(file, join(h.dir, 'block.csv'));
    await service.open(file, { parquet: 'never' });
    const columns = await service.columns(table);
    const where = toFragment(compileWhere([{ kind: 'range', column: 'id', max: 3000, maxInclusive: true, minInclusive: true }], columns));
    const page = await service.rows(table, { offset: 0, limit: 1000, sort, where }, { viewId: 'grid' });
    expect(decode(page.value).numRows).toBe(1000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(service.debugState().sortIndexes).toBe(0);
    // Pages past the end of a complete block are empty without any index.
    const past = await service.rows(table, { offset: 3000, limit: 1000, sort, where }, { viewId: 'grid' });
    expect(decode(past.value).numRows).toBe(0);
    expect(service.debugState().sortIndexes).toBe(0);
  });
});

describe('deep unsorted pages on CSV', () => {
  const ROWS = 250_000;
  let path: string;

  beforeAll(async () => {
    path = join(h.dir, 'deep.csv');
    await writeFixtureCsv(path, ROWS);
  });

  it.skipIf(!hasParquet)('switch to the Parquet copy (converting on demand) in auto mode', async () => {
    const service = await h.restart();
    await service.clearCache('parquet');
    const file = toFileHandle(randomUUID());
    service.registerFile(file, path);
    const table = tableIdForFile(file);
    const handle = await service.open(file);
    expect(handle.usingParquetCache).toBe(false);
    // Shallow pages read the CSV.
    await service.rows(table, { offset: 1000, limit: 10 });
    expect(service.debugState().conversions).toBe(0);
    const deep = await service.rows(table, { offset: ROWS - 1000, limit: 1000 });
    expect(columnValues(decode(deep.value), 'id')).toEqual(Array.from({ length: 1000 }, (_, i) => ROWS - 999 + i));
    const reopened = await service.open(file);
    expect(reopened.usingParquetCache).toBe(true);
  });

  it('use OFFSET over the CSV when Parquet is off', async () => {
    const service = await h.restart();
    await service.clearCache('parquet');
    const file = toFileHandle(randomUUID());
    service.registerFile(file, path);
    const table = tableIdForFile(file);
    await service.open(file, { parquet: 'never' });
    const deep = await service.rows(table, { offset: ROWS - 10, limit: 10 });
    expect(columnValues(decode(deep.value), 'id')).toEqual(Array.from({ length: 10 }, (_, i) => ROWS - 9 + i));
    expect((await service.open(file, { parquet: 'never' })).usingParquetCache).toBe(false);
  });
});

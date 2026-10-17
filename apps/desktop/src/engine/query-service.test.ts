import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DataType } from 'apache-arrow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SortKey, TableId } from '@glassgrid/core';
import { EngineFailure } from './errors';
import { columnValues, createHarness, decode, fixtureRow, writeFixtureCsv, type Harness } from './test-support';

const ROWS = 25_000;
let h: Harness;
let fixture: { table: TableId; path: string };
let typed: { table: TableId; path: string };

beforeAll(async () => {
  h = await createHarness();
  const path = join(h.dir, 'fixture.csv');
  await writeFixtureCsv(path, ROWS);
  fixture = { table: h.register(path).table, path };

  const typedPath = join(h.dir, 'typed.csv');
  await writeFile(
    typedPath,
    [
      'int_col,float_col,bool_col,date_col,ts_col,text_col,empty_col',
      '1,1.5,true,2024-01-01,2024-01-01 10:00:00,apple,',
      ',2.5,false,2024-02-01,2024-01-02 11:30:00,,',
      '3,,true,,2024-01-03 00:00:00,cherry,',
      '4,-0.5,,2024-03-01,,banana,',
      '',
    ].join('\n'),
  );
  typed = { table: h.register(typedPath).table, path: typedPath };
  for (const t of [fixture, typed]) {
    await h.service.open(`fh_${t.table.slice(3)}` as never, { parquet: 'never' });
  }
});

afterAll(async () => {
  await h.dispose();
});

async function page(table: TableId, offset: number, limit: number, sort?: SortKey[]) {
  const { value, cached } = await h.service.rows(table, { offset, limit, ...(sort ? { sort } : {}) });
  return { table: decode(value), cached };
}

async function ids(table: TableId, offset: number, limit: number, sort?: SortKey[]): Promise<number[]> {
  return columnValues((await page(table, offset, limit, sort)).table, 'id') as number[];
}

/** Reference order: JS sort by the keys, ties by file position. */
function referenceIds(compare: (a: number, b: number) => number): number[] {
  const order = Array.from({ length: ROWS }, (_, i) => i);
  order.sort((a, b) => compare(a, b) || a - b);
  return order.map((i) => i + 1);
}

describe('open', () => {
  it('returns a table handle with columns and fingerprint, without a row count for CSV', async () => {
    const file = `fh_${fixture.table.slice(3)}` as never;
    const handle = await h.service.open(file, { parquet: 'never' });
    expect(handle.id).toBe(fixture.table);
    expect(handle.fileName).toBe('fixture.csv');
    expect(handle.usingParquetCache).toBe(false);
    expect(handle.fingerprint.key).toMatch(/^[0-9a-f]{32}$/);
    expect(handle.columns).toEqual([
      { name: 'id', type: 'integer', duckdbType: 'BIGINT' },
      { name: 'category', type: 'text', duckdbType: 'VARCHAR' },
      { name: 'amount', type: 'float', duckdbType: 'DOUBLE' },
      { name: 'created_on', type: 'date', duckdbType: 'DATE' },
    ]);
  });

  it('sniffs the dialect once: quoted fields, semicolons, CRLF, no header, quotes in the path', async () => {
    const semi = join(h.dir, "it's; semi.csv");
    await writeFile(
      semi,
      'name;note;when\r\n"Smith; J";"said ""hi""";2024-01-02 03:04:05\r\nDoe;plain;2024-02-03 04:05:06\r\n',
    );
    const a = h.register(semi);
    const handle = await h.service.open(a.file, { parquet: 'never' });
    expect(handle.columns.map((c) => [c.name, c.type])).toEqual([
      ['name', 'text'],
      ['note', 'text'],
      ['when', 'timestamp'],
    ]);
    const rows = decode((await h.service.rows(a.table, { offset: 0, limit: 10 })).value);
    expect(columnValues(rows, 'name')).toEqual(['Smith; J', 'Doe']);
    expect(columnValues(rows, 'note')).toEqual(['said "hi"', 'plain']);

    const bare = join(h.dir, 'bare.csv');
    await writeFile(bare, '1|x\n2|y\n');
    const b = h.register(bare);
    expect((await h.service.open(b.file, { parquet: 'never' })).columns.map((c) => c.name)).toEqual([
      'column0',
      'column1',
    ]);
    expect((await h.service.count(b.table)).value).toBe(2);
  });

  it('reports unreadable CSVs as errors, not crashes', async () => {
    const empty = join(h.dir, 'empty.csv');
    await writeFile(empty, '');
    const { file, table } = h.register(empty);
    const outcome = await h.service.open(file, { parquet: 'never' }).then(
      async () => (await h.service.count(table)).value,
      (error: unknown) => error,
    );
    // DuckDB may read an empty file as zero rows or refuse it; either is fine, a crash is not.
    expect(outcome === 0 || outcome instanceof EngineFailure).toBe(true);
  });

  it('rejects unknown files and tables with structured errors', async () => {
    await expect(h.service.open('fh_00000000-0000-0000-0000-000000000000' as never)).rejects.toMatchObject({
      code: 'unknown_handle',
    });
    await expect(h.service.count('tb_00000000-0000-0000-0000-000000000000' as TableId)).rejects.toMatchObject({
      code: 'unknown_table',
    });
  });
});

describe('profile', () => {
  it('reports simple types, null fractions, distinct counts and min/max', async () => {
    const { value: profile } = await h.service.profile(typed.table);
    expect(profile.rowCount).toBe(4);
    const byName = Object.fromEntries(profile.columns.map((column) => [column.name, column]));

    expect(byName['int_col']).toMatchObject({ type: 'integer', nullFraction: 0.25, distinctCount: 3, min: 1, max: 4 });
    expect(byName['float_col']).toMatchObject({ type: 'float', nullFraction: 0.25, distinctCount: 3, min: -0.5, max: 2.5 });
    expect(byName['bool_col']).toMatchObject({ type: 'boolean', nullFraction: 0.25, distinctCount: 2, min: false, max: true });
    expect(byName['date_col']).toMatchObject({
      type: 'date',
      nullFraction: 0.25,
      min: '2024-01-01',
      max: '2024-03-01',
    });
    expect(byName['ts_col']).toMatchObject({
      type: 'timestamp',
      nullFraction: 0.25,
      min: '2024-01-01 10:00:00',
      max: '2024-01-03 00:00:00',
    });
    expect(byName['text_col']).toMatchObject({ type: 'text', nullFraction: 0.25, min: 'apple', max: 'cherry' });
    expect(byName['empty_col']).toMatchObject({ nullFraction: 1, distinctCount: 0, min: null, max: null });
  });

  it('is served from the result cache the second time', async () => {
    const first = await h.service.profile(fixture.table);
    const second = await h.service.profile(fixture.table);
    expect(second.cached).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(first.value.rowCount).toBe(ROWS);
    const amount = first.value.columns.find((column) => column.name === 'amount');
    expect(amount?.nullFraction).toBe(0);
    // HyperLogLog: an estimate near the true 25,000.
    expect(amount?.distinctCount).toBeGreaterThan(ROWS * 0.8);
    expect(amount?.distinctCount).toBeLessThan(ROWS * 1.2);
  });
});

describe('rows: unsorted', () => {
  it('pages in file order with exact boundaries', async () => {
    expect(await ids(fixture.table, 0, 1000)).toEqual(Array.from({ length: 1000 }, (_, i) => i + 1));
    expect(await ids(fixture.table, 1000, 3)).toEqual([1001, 1002, 1003]);
    expect(await ids(fixture.table, ROWS - 2, 1000)).toEqual([ROWS - 1, ROWS]);
  });

  it('returns an empty page with the full schema past the end', async () => {
    const { table } = await page(fixture.table, ROWS + 10, 100);
    expect(table.numRows).toBe(0);
    expect(table.schema.fields.map((field) => field.name)).toEqual(['id', 'category', 'amount', 'created_on']);
  });

  it('encodes dates and timestamps as Arrow temporal types and keeps nulls', async () => {
    const { table } = await page(typed.table, 0, 10);
    const field = (name: string): DataType | undefined => table.schema.fields.find((f) => f.name === name)?.type as DataType | undefined;
    expect(DataType.isDate(field('date_col'))).toBe(true);
    expect(DataType.isTimestamp(field('ts_col'))).toBe(true);
    expect(DataType.isInt(field('int_col'))).toBe(true);
    expect(DataType.isBool(field('bool_col'))).toBe(true);
    expect(columnValues(table, 'date_col')).toEqual([Date.UTC(2024, 0, 1), Date.UTC(2024, 1, 1), null, Date.UTC(2024, 2, 1)]);
    expect(columnValues(table, 'ts_col')).toEqual([
      Date.UTC(2024, 0, 1, 10),
      Date.UTC(2024, 0, 2, 11, 30),
      Date.UTC(2024, 0, 3),
      null,
    ]);
    expect(columnValues(table, 'int_col')).toEqual([1, null, 3, 4]);
    expect(columnValues(table, 'text_col')).toEqual(['apple', null, 'cherry', 'banana']);
  });
});

describe('rows: sorted', () => {
  it('breaks ties by file order and pages consistently across boundaries', async () => {
    const sort: SortKey[] = [{ column: 'category', direction: 'asc' }];
    const expected = referenceIds((a, b) => fixtureRow(a).category.localeCompare(fixtureRow(b).category));

    const all: number[] = [];
    for (let offset = 0; offset < ROWS; offset += 1000) all.push(...(await ids(fixture.table, offset, 1000, sort)));
    expect(all).toEqual(expected);
    // Unaligned windows agree with the same order.
    expect(await ids(fixture.table, 4_990, 20, sort)).toEqual(expected.slice(4_990, 5_010));
    expect(await ids(fixture.table, ROWS - 5, 1000, sort)).toEqual(expected.slice(ROWS - 5));
  });

  it('supports descending, multi-key sorts', async () => {
    const sort: SortKey[] = [
      { column: 'category', direction: 'desc' },
      { column: 'amount', direction: 'asc' },
    ];
    const expected = referenceIds(
      (a, b) =>
        fixtureRow(b).category.localeCompare(fixtureRow(a).category) || fixtureRow(a).amount - fixtureRow(b).amount,
    );
    expect(await ids(fixture.table, 0, 1000, sort)).toEqual(expected.slice(0, 1000));
    expect(await ids(fixture.table, 12_345, 777, sort)).toEqual(expected.slice(12_345, 12_345 + 777));
  });

  it('places nulls last in both directions', async () => {
    const asc = columnValues((await page(typed.table, 0, 10, [{ column: 'int_col', direction: 'asc' }])).table, 'int_col');
    expect(asc).toEqual([1, 3, 4, null]);
    const desc = columnValues((await page(typed.table, 0, 10, [{ column: 'int_col', direction: 'desc' }])).table, 'int_col');
    expect(desc).toEqual([4, 3, 1, null]);
  });

  it('rejects unknown sort columns', async () => {
    const error: unknown = await page(fixture.table, 0, 10, [{ column: 'nope', direction: 'asc' }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EngineFailure);
    expect(error).toMatchObject({ code: 'unknown_column' });
  });

  it('quotes column names (no SQL injection through sort keys)', async () => {
    const path = join(h.dir, 'weird.csv');
    await writeFile(path, '"we""ird col",b\n2,x\n1,y\n');
    const { file, table } = h.register(path);
    const handle = await h.service.open(file, { parquet: 'never' });
    expect(handle.columns.map((c) => c.name)).toEqual(['we"ird col', 'b']);
    const sorted = await page(table, 0, 10, [{ column: 'we"ird col', direction: 'asc' }]);
    expect(columnValues(sorted.table, 'b')).toEqual(['y', 'x']);
  });
});

describe('rows and count with a compiled WHERE fragment', () => {
  it('filters, keeps file order when unsorted, and counts', async () => {
    const where = { sql: '"category" = ? AND "amount" >= ?', params: ['bravo', 5000] };
    const expected = Array.from({ length: ROWS }, (_, i) => fixtureRow(i))
      .filter((row) => row.category === 'bravo' && row.amount >= 5000)
      .map((row) => row.id);

    const { value } = await h.service.rows(fixture.table, { offset: 0, limit: 1000, where });
    expect(columnValues(decode(value), 'id')).toEqual(expected.slice(0, 1000));
    const { value: count } = await h.service.count(fixture.table, where);
    expect(count).toBe(expected.length);

    const sorted = await h.service.rows(fixture.table, {
      offset: 10,
      limit: 5,
      where,
      sort: [{ column: 'amount', direction: 'desc' }],
    });
    const bySortedAmount = Array.from({ length: ROWS }, (_, i) => fixtureRow(i))
      .filter((row) => row.category === 'bravo' && row.amount >= 5000)
      .sort((a, b) => b.amount - a.amount || a.id - b.id)
      .map((row) => row.id);
    expect(columnValues(decode(sorted.value), 'id')).toEqual(bySortedAmount.slice(10, 15));
  });
});

describe('count', () => {
  it('counts rows and caches the result', async () => {
    const path = join(h.dir, 'count.csv');
    await writeFixtureCsv(path, 1234);
    const { file, table } = h.register(path);
    await h.service.open(file, { parquet: 'never' });
    const first = await h.service.count(table);
    expect(first).toEqual({ value: 1234, cached: false });
    expect(await h.service.count(table)).toEqual({ value: 1234, cached: true });
    expect((await h.service.open(file)).rowCount).toBe(1234);
  });
});

describe('aggregate', () => {
  it('is a typed stub until the compiler lands', async () => {
    await expect(h.service.aggregate(fixture.table, { sql: 'SELECT 1', params: [] })).rejects.toMatchObject({
      code: 'not_implemented',
    });
  });
});

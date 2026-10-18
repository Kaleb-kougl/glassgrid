import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DataType } from 'apache-arrow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileWhere, tableIdForFile, toFileHandle, type EngineResponse, type FileHandle, type TableId } from '@glassgrid/core';
import { EngineSession, runAggregate, toFragment } from './session';
import { columnValues, createHarness, decode, type Harness } from './test-support';

/*
 * setColumnTypes: TRY_CAST per overridden column, failed-cast counts, cache
 * and sort-index invalidation, profiles and compiled filters that see the
 * new types.
 */

let h: Harness;
let path: string;

// `code` looks numeric but has junk; `amount` is text with a thousands
// separator in one row; `flag` is 0/1; `day` is ISO text.
const CSV = [
  'id,code,amount,flag,day',
  '1,10,1.5,1,2024-01-03',
  '2,9,2.25,0,2024-01-01',
  '3,x1,"1,000.5",1,not a day',
  '4,100,,0,2024-01-02',
  '5,,3,1,',
  '6,abc,0.125,0,2024-02-30',
  '',
].join('\n');

beforeAll(async () => {
  h = await createHarness();
  path = join(h.dir, 'types.csv');
  await writeFile(path, CSV);
});

afterAll(async () => {
  await h.dispose();
});

async function openFresh(parquet: 'never' | 'always' = 'never'): Promise<{ file: FileHandle; table: TableId }> {
  const file = toFileHandle(randomUUID());
  h.service.registerFile(file, path);
  const table = tableIdForFile(file);
  await h.service.open(file, { parquet });
  if (parquet === 'always') await h.service.ensureParquetCache(table);
  return { file, table };
}

async function column(table: TableId, name: string, sort?: { column: string; direction: 'asc' | 'desc' }[]) {
  const page = await h.service.rows(table, { offset: 0, limit: 100, ...(sort ? { sort } : {}) });
  const decoded = decode(page.value);
  return { values: columnValues(decoded, name), field: decoded.schema.fields.find((field) => field.name === name) };
}

describe.each(['never', 'always'] as const)('setColumnTypes (parquet: %s)', (parquet) => {
  it('casts with TRY_CAST, counts failed casts and changes the effective types', async () => {
    const { table } = await openFresh(parquet);
    expect((await h.service.columns(table)).find((c) => c.name === 'code')).toMatchObject({ type: 'text' });

    const outcome = await h.service.setColumnTypes(table, [
      { column: 'code', type: 'integer' },
      { column: 'day', type: 'date' },
      { column: 'flag', type: 'boolean' },
    ]);
    expect(outcome.columns).toEqual([
      { column: 'code', type: 'integer', duckdbType: 'BIGINT', failedCasts: 2 },
      { column: 'day', type: 'date', duckdbType: 'DATE', failedCasts: 2 },
      { column: 'flag', type: 'boolean', duckdbType: 'BOOLEAN', failedCasts: 0 },
    ]);
    expect(outcome.table.typeOverrides).toEqual([
      { column: 'code', type: 'integer' },
      { column: 'day', type: 'date' },
      { column: 'flag', type: 'boolean' },
    ]);
    expect(outcome.table.columns.find((c) => c.name === 'code')).toEqual({ name: 'code', type: 'integer', duckdbType: 'BIGINT' });

    const code = await column(table, 'code');
    expect(code.values).toEqual([10, 9, null, 100, null, null]);
    expect(code.field && DataType.isInt(code.field.type)).toBe(true);
    const day = await column(table, 'day');
    expect(day.field && DataType.isDate(day.field.type)).toBe(true);
    expect(day.values.filter((value) => value === null)).toHaveLength(3);
    expect((await column(table, 'flag')).values).toEqual([true, false, true, false, true, false]);

    // Sorting is numeric now (text would put "100" before "9").
    const sorted = await column(table, 'id', [{ column: 'code', direction: 'asc' }]);
    expect(sorted.values).toEqual([2, 1, 4, 3, 5, 6]);
  });

  it('feeds the overridden types to the profile and the compiler', async () => {
    const { table } = await openFresh(parquet);
    const before = await h.service.profile(table);
    expect(before.value.columns.find((c) => c.name === 'code')).toMatchObject({ type: 'text', min: '10', max: 'x1' });

    await h.service.setColumnTypes(table, [{ column: 'code', type: 'integer' }]);
    const after = await h.service.profile(table);
    expect(after.value.columns.find((c) => c.name === 'code')).toMatchObject({
      type: 'integer',
      duckdbType: 'BIGINT',
      min: 9,
      max: 100,
      nullFraction: 0.5,
    });
    // The setColumnTypes scan already profiled the column, so this came from the stats cache.
    expect(after.cached).toBe(true);

    // A numeric range filter compiles against the integer column ("sum" needs numeric too).
    const columns = await h.service.columns(table);
    const where = toFragment(compileWhere([{ kind: 'range', column: 'code', min: 10, minInclusive: true, maxInclusive: true }], columns));
    expect((await h.service.count(table, where)).value).toBe(2);
    const chart = await runAggregate(h.service, table, { mark: 'bar', x: { column: 'flag' }, y: { column: 'code', aggregate: 'sum' }, filters: [] }, {});
    const bars = decode(chart.value);
    expect(columnValues(bars, 'y')).toEqual([109, 10]);
  });

  it('invalidates cached pages and sort indexes, and reverts to the inferred types', async () => {
    const { table } = await openFresh(parquet);
    const sort = [{ column: 'code', direction: 'desc' as const }];
    const textOrder = (await column(table, 'id', sort)).values;
    expect(textOrder).toEqual([3, 6, 2, 4, 1, 5]); // "x1" > "abc" > "9" > "100" > "10", NULL last

    await h.service.setColumnTypes(table, [{ column: 'code', type: 'integer' }]);
    expect((await column(table, 'id', sort)).values).toEqual([4, 1, 2, 3, 5, 6]);

    // The complete set replaces the previous one: an empty list clears every override.
    const reverted = await h.service.setColumnTypes(table, []);
    expect(reverted.table.typeOverrides).toBeUndefined();
    expect((await column(table, 'id', sort)).values).toEqual(textOrder);
    // Listing a column with its inferred type is the same as leaving it out.
    const same = await h.service.setColumnTypes(table, [{ column: 'code', type: 'text' }]);
    expect(same.columns).toEqual([{ column: 'code', type: 'text', duckdbType: 'VARCHAR', failedCasts: 0 }]);
    expect(same.table.typeOverrides).toBeUndefined();
  });

  it('maps decimal overrides to DECIMAL(38,6) and keeps text overrides of numbers exact', async () => {
    const { table } = await openFresh(parquet);
    const decimal = await h.service.setColumnTypes(table, [
      { column: 'amount', type: 'decimal' },
      { column: 'id', type: 'text' },
    ]);
    expect(decimal.columns).toEqual([
      { column: 'amount', type: 'decimal', duckdbType: 'DECIMAL(38,6)', failedCasts: 1 },
      { column: 'id', type: 'text', duckdbType: 'VARCHAR', failedCasts: 0 },
    ]);
    const amount = await column(table, 'amount');
    expect(amount.field && DataType.isDecimal(amount.field.type)).toBe(true);
    expect((await column(table, 'id')).values).toEqual(['1', '2', '3', '4', '5', '6']);
  });
});

describe('setColumnTypes errors and atomicity', () => {
  it('rejects unknown columns and leaves the table unchanged', async () => {
    const { table } = await openFresh();
    await expect(h.service.setColumnTypes(table, [{ column: 'nope', type: 'integer' }])).rejects.toMatchObject({
      code: 'unknown_column',
    });
    expect((await h.service.columns(table)).find((c) => c.name === 'code')?.type).toBe('text');
  });

  it('changes nothing when cancelled before the scan finishes', async () => {
    const { table } = await openFresh();
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.service.setColumnTypes(table, [{ column: 'code', type: 'integer' }], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect((await h.service.columns(table)).find((c) => c.name === 'code')?.type).toBe('text');
  });

  it('is a protocol request answered with columnTypes', async () => {
    const { table } = await openFresh();
    const sent: EngineResponse[] = [];
    const session = new EngineSession(Promise.resolve(h.service), (message) => sent.push(message));
    session.handle({ kind: 'setColumnTypes', requestId: 't1', table, overrides: [{ column: 'code', type: 'float' }] });
    session.handle({ kind: 'setColumnTypes', requestId: 't2', table, overrides: [{ column: 'code', type: 'float' }, { column: 'code', type: 'text' }] });
    for (let i = 0; i < 400 && sent.filter((m) => m.kind !== 'event').length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    session.dispose();
    expect(sent.find((m) => m.kind !== 'event' && m.requestId === 't2')).toMatchObject({ kind: 'error', code: 'bad_request' });
    expect(sent.find((m) => m.kind !== 'event' && m.requestId === 't1')).toMatchObject({
      kind: 'columnTypes',
      columns: [{ column: 'code', type: 'float', duckdbType: 'DOUBLE', failedCasts: 2 }],
      table: { id: table, typeOverrides: [{ column: 'code', type: 'float' }] },
    });
    expect(sent.some((m) => m.kind === 'event' && m.event.type === 'tableUpdated')).toBe(true);
  });
});

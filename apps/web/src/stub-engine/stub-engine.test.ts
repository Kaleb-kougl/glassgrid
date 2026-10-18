import { describe, expect, it } from 'vitest';
import { chartColumnsFromArrow } from '@glassgrid/ui';
import { isAbandoned } from '@glassgrid/app';
import { tableIdForFile, type FileHandle, type OpenCsvResult } from '@glassgrid/core';
import { castCell, SAMPLE_ROWS, sampleTrips } from './sample-trips';
import { createStubEngine } from './stub-engine';

let ids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

async function openSample() {
  const stub = createStubEngine({ newId: uuid });
  const picked = await stub.openSample('sample-trips');
  if (picked.status !== 'opened') throw new Error('sample did not open');
  const { table } = await stub.engine.open(picked.file.handle);
  return { stub, table, id: table.id };
}

const handleOf = (result: OpenCsvResult): FileHandle => {
  if (result.status !== 'opened') throw new Error(`not opened: ${result.status}`);
  return result.file.handle;
};

describe('sample dataset', () => {
  it('is fixed: the same rows on every call', () => {
    expect(sampleTrips()).toEqual(sampleTrips());
    const columns = sampleTrips();
    expect(columns.map((column) => [column.name, column.type, column.values.length])).toEqual([
      ['pickup_at', 'timestamp', SAMPLE_ROWS],
      ['payment_type', 'text', SAMPLE_ROWS],
      ['trip_distance', 'float', SAMPLE_ROWS],
      ['fare_amount', 'float', SAMPLE_ROWS],
      ['passengers', 'integer', SAMPLE_ROWS],
    ]);
  });

  it('casts like TRY_CAST: NULL when a value does not convert', () => {
    expect(castCell('12', 'text', 'integer')).toBe(12);
    expect(castCell('Cash', 'text', 'integer')).toBeNull();
    expect(castCell(2.6, 'float', 'integer')).toBe(3);
    expect(castCell(Date.UTC(2024, 2, 1, 8, 15), 'timestamp', 'text')).toBe('2024-03-01 08:15:00');
    expect(castCell('2024-03-01 08:15:00', 'text', 'timestamp')).toBe(Date.UTC(2024, 2, 1, 8, 15));
    expect(castCell('yes', 'text', 'boolean')).toBe(true);
    expect(castCell(null, 'text', 'integer')).toBeNull();
  });
});

describe('stub engine (temporary)', () => {
  it('registers picked files by name and size and opens them as the sample', async () => {
    const stub = createStubEngine({ newId: uuid });
    const handle = handleOf(await stub.registerFile({ name: 'mine.csv', size: 1_234, lastModified: 1_700_000_000_000 }));
    const { table } = await stub.engine.open(handle);
    expect(table).toMatchObject({ id: tableIdForFile(handle), fileName: 'mine.csv', rowCount: SAMPLE_ROWS, usingParquetCache: false });
    expect(table.fingerprint).toMatchObject({ sizeBytes: 1_234, mtimeMs: 1_700_000_000_000 });
    expect(table.columns.map((column) => `${column.name}:${column.duckdbType}`)).toEqual([
      'pickup_at:TIMESTAMP',
      'payment_type:VARCHAR',
      'trip_distance:DOUBLE',
      'fare_amount:DOUBLE',
      'passengers:BIGINT',
    ]);
    await expect(stub.engine.open('fh_unknown-handle' as FileHandle)).rejects.toMatchObject({ code: 'unknown_handle' });
    expect(await stub.openSample('nope')).toEqual({ status: 'failed', message: 'No sample named nope' });
  });

  it('profiles, counts and pages with filters and sorting', async () => {
    const { stub, id } = await openSample();
    const profile = await stub.engine.profile(id);
    expect(profile.rowCount).toBe(SAMPLE_ROWS);
    const payment = profile.columns.find((column) => column.name === 'payment_type');
    expect(payment).toMatchObject({ type: 'text', duckdbType: 'VARCHAR' });
    expect(payment?.nullFraction).toBeGreaterThan(0);
    expect(profile.columns[0]?.min).toMatch(/^2024-03-01 \d\d:\d\d:00$/);

    const cash = [{ kind: 'in' as const, column: 'payment_type', values: ['Cash'] }];
    const { rowCount } = await stub.engine.count(id, { filters: cash });
    expect(rowCount).toBeGreaterThan(0);
    expect(rowCount).toBeLessThan(SAMPLE_ROWS);
    const notCash = await stub.engine.count(id, { filters: [{ kind: 'notIn', column: 'payment_type', values: ['Cash'] }] });
    expect(rowCount + notCash.rowCount).toBe(SAMPLE_ROWS); // NULLs match notIn

    const page = await stub.engine.pageFetcher(id, { viewId: 'grid', sort: [{ column: 'fare_amount', direction: 'desc' }], filters: cash })(0, 1000);
    expect(page.table.numRows).toBe(rowCount);
    const fares = page.table.getChild('fare_amount')?.toArray() as Float64Array;
    expect([...fares]).toEqual([...fares].sort((a, b) => b - a));
    expect(page.table.getChild('payment_type')?.get(0)).toBe('Cash');
    const second = await stub.engine.pageFetcher(id)(10, 5);
    expect(second.table.numRows).toBe(5);

    const range = await stub.engine.count(id, { filters: [{ kind: 'range', column: 'pickup_at', min: '2024-03-01', max: '2024-03-08', maxInclusive: false }] });
    expect(range.rowCount).toBeGreaterThan(30);
    expect(range.rowCount).toBeLessThan(80);
  });

  it('answers every mark with the compiler’s result shape', async () => {
    const { stub, id } = await openSample();
    const total = (values: Float64Array) => values.reduce((sum, value) => sum + value, 0);

    const bar = await stub.engine.aggregate(id, { mark: 'bar', x: { column: 'payment_type' }, limit: 2, other: true });
    expect(bar.table.schema.fields.map((field) => field.name)).toEqual(['x', 'x_other', 'y']);
    const bars = chartColumnsFromArrow(bar.table, 'bar');
    expect(bars.categories?.map((category) => category.label)).toEqual(['Credit card', 'Cash', 'Other']);
    expect(total(bars.y)).toBe(SAMPLE_ROWS);

    const histogram = await stub.engine.aggregate(id, { mark: 'histogram', x: { column: 'trip_distance', bin: 1 } });
    expect(histogram.table.schema.fields.map((field) => field.name)).toEqual(['x', 'x_end', 'y']);
    expect(total(chartColumnsFromArrow(histogram.table, 'histogram').y)).toBe(SAMPLE_ROWS);

    const line = await stub.engine.aggregate(id, { mark: 'line', x: { column: 'pickup_at', timeUnit: 'day' }, y: { column: 'fare_amount', aggregate: 'avg' }, pixelWidth: 600 });
    expect(line.table.numRows).toBe(31);
    expect(String(line.table.schema.fields[0]?.type)).toBe('Timestamp<MILLISECOND>');

    const heatmap = await stub.engine.aggregate(id, { mark: 'heatmap', x: { column: 'trip_distance', bin: 5 }, y: { column: 'fare_amount', bin: 10 } });
    expect(heatmap.table.schema.fields.map((field) => field.name)).toEqual(['x', 'x_end', 'y', 'y_end', 'count']);
    expect(total(chartColumnsFromArrow(heatmap.table, 'heatmap').count as Float64Array)).toBe(SAMPLE_ROWS);

    const scatter = await stub.engine.aggregate(id, { mark: 'scatter', x: { column: 'trip_distance' }, y: { column: 'fare_amount' }, color: { column: 'payment_type' } });
    expect(scatter.table.schema.fields.map((field) => field.name)).toEqual(['x', 'y', 'color', 'color_other']);
    expect(scatter.table.numRows).toBe(SAMPLE_ROWS);
    expect(scatter.fellBackToHeatmap).toBe(false);

    const tooMany = await stub.engine.aggregate(id, { mark: 'scatter', x: { column: 'trip_distance' }, y: { column: 'fare_amount' }, limit: 10 });
    expect([tooMany.mark, tooMany.fellBackToHeatmap]).toEqual(['heatmap', true]);

    const filtered = await stub.engine.aggregate(id, { mark: 'bar', x: { column: 'payment_type' }, filters: [{ kind: 'in', column: 'payment_type', values: ['Cash'] }] });
    expect(filtered.table.numRows).toBe(1);
  });

  it('rejects specs the compiler rejects, with the offending path', async () => {
    const { stub, id } = await openSample();
    await expect(stub.engine.aggregate(id, { mark: 'bar', x: { column: 'payment_type' }, y: { column: 'payment_type', aggregate: 'sum' } })).rejects.toMatchObject({
      code: 'bad_request',
      path: 'y.aggregate',
    });
    await expect(stub.engine.aggregate(id, { mark: 'bar', x: { column: 'nope' } })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('applies type overrides and counts failed casts', async () => {
    const { stub, id } = await openSample();
    const result = await stub.engine.setColumnTypes(id, [{ column: 'payment_type', type: 'integer' }]);
    expect(result.columns).toEqual([{ column: 'payment_type', type: 'integer', duckdbType: 'BIGINT', failedCasts: expect.any(Number) as unknown }]);
    expect(result.columns[0]?.failedCasts).toBeGreaterThan(200);
    expect(result.table.typeOverrides).toEqual([{ column: 'payment_type', type: 'integer' }]);
    expect(result.table.columns.find((column) => column.name === 'payment_type')?.type).toBe('integer');
    const cleared = await stub.engine.setColumnTypes(id, []);
    expect(cleared.table.typeOverrides).toBeUndefined();
  });

  it('builds no cubes, rejects aborted requests as abandoned and forgets closed tables', async () => {
    const { stub, id } = await openSample();
    const prepared = await stub.engine.prepareCrossfilter(id, { dimension: { column: 'trip_distance', bin: { kind: 'width', width: 1 } }, targets: [{ kind: 'count', filters: [] }] });
    expect(prepared.cubes).toEqual([{ status: 'skipped', reason: 'The stub engine builds no cubes' }]);
    const controller = new AbortController();
    controller.abort();
    const aborted = stub.engine.pageFetcher(id)(0, 10, controller.signal);
    await expect(aborted).rejects.toMatchObject({ code: 'cancelled' });
    expect(isAbandoned(await aborted.catch((error: unknown) => error))).toBe(true);
    await stub.engine.closeTable(id);
    await expect(stub.engine.count(id)).rejects.toMatchObject({ code: 'unknown_table' });
  });
});

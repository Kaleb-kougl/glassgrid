import type { Table } from 'apache-arrow';
import type { AggregateSpecInput, FileHandle, FilterInput, SortKey, TableId } from '@glassgrid/core';
import { isAbandoned } from '../client/port-client';
import type { EngineClientApi } from '../client/types';
import { CATEGORIES, fixtureRow } from './fixture';

/*
 * A representative engine scenario against any `EngineClientApi`: the
 * desktop path (native DuckDB behind a MessagePort), DuckDB-WASM in Node, and
 * DuckDB-WASM in a browser Web Worker (`createWorkerEngine`) all run the same
 * steps on the same fixture and must give the same answers. Runtime-neutral:
 * no Node, no DOM. Each step throws on a wrong answer.
 */

export interface ScenarioStep {
  name: string;
  ms: number;
}

export class ScenarioFailure extends Error {
  constructor(step: string, message: string) {
    super(`${step}: ${message}`);
    this.name = 'ScenarioFailure';
  }
}

function check(step: string, condition: boolean, message: string): void {
  if (!condition) throw new ScenarioFailure(step, message);
}

function same(step: string, actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual, (_key, value: unknown) => (typeof value === 'bigint' ? Number(value) : value));
  const e = JSON.stringify(expected, (_key, value: unknown) => (typeof value === 'bigint' ? Number(value) : value));
  if (a !== e) throw new ScenarioFailure(step, `${what}: expected ${e.slice(0, 400)}, got ${a.slice(0, 400)}`);
}

function column(table: Table, name: string): unknown[] {
  const vector = table.getChild(name);
  if (!vector) throw new Error(`No column ${name} in ${table.schema.fields.map((field) => field.name).join(', ')}`);
  return [...vector].map((value: unknown) => (typeof value === 'bigint' ? Number(value) : value));
}

function numbers(table: Table, name: string): number[] {
  return column(table, name).map(Number);
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** Run the scenario on a freshly registered fixture of `rows` rows (`fixtureCsv(rows)`). */
export async function runScenario(engine: EngineClientApi, file: FileHandle, rows: number): Promise<ScenarioStep[]> {
  const steps: ScenarioStep[] = [];
  const reference = Array.from({ length: rows }, (_, i) => fixtureRow(i));
  let table = '' as TableId;

  const step = async (name: string, body: () => Promise<void>) => {
    const started = performance.now();
    await body();
    steps.push({ name, ms: Math.round((performance.now() - started) * 10) / 10 });
  };

  await step('open', async () => {
    const opened = await engine.open(file, { parquet: 'never' });
    table = opened.table.id;
    same('open', opened.table.columns, [
      { name: 'id', type: 'integer', duckdbType: 'BIGINT' },
      { name: 'category', type: 'text', duckdbType: 'VARCHAR' },
      { name: 'amount', type: 'float', duckdbType: 'DOUBLE' },
      { name: 'created_on', type: 'date', duckdbType: 'DATE' },
    ], 'columns');
  });

  await step('first page', async () => {
    const page = await engine.pageFetcher(table)(0, 1000);
    same('first page', column(page.table, 'id').slice(0, 5), [1, 2, 3, 4, 5], 'ids');
    check('first page', page.table.numRows === Math.min(1000, rows), `numRows ${page.table.numRows}`);
  });

  await step('profile', async () => {
    const profile = await engine.profile(table, { viewId: 'profile' });
    check('profile', profile.rowCount === rows, `rowCount ${profile.rowCount}`);
    const amounts = reference.map((row) => row.amount);
    const amount = profile.columns.find((candidate) => candidate.name === 'amount');
    same('profile', [amount?.min, amount?.max, amount?.nullFraction], [Math.min(...amounts), Math.max(...amounts), 0], 'amount min/max/nulls');
    const created = profile.columns.find((candidate) => candidate.name === 'created_on');
    same('profile', [created?.min, created?.max], ['2026-01-01', '2026-12-28'], 'created_on min/max (DuckDB text)');
    const category = profile.columns.find((candidate) => candidate.name === 'category');
    check('profile', category?.distinctCount === CATEGORIES.length, `category distinct ${category?.distinctCount}`);
  });

  const sort: SortKey[] = [{ column: 'amount', direction: 'desc' }];
  const sortedIds = [...reference].sort((a, b) => b.amount - a.amount || a.id - b.id).map((row) => row.id);

  await step('sorted first page', async () => {
    const page = await engine.pageFetcher(table, { viewId: 'grid', sort })(0, 1000);
    same('sorted first page', column(page.table, 'id'), sortedIds.slice(0, 1000), 'ids');
  });

  await step('sorted deep page', async () => {
    const offset = Math.max(0, rows - 1000);
    const page = await engine.pageFetcher(table, { viewId: 'grid', sort })(offset, 1000);
    same('sorted deep page', column(page.table, 'id'), sortedIds.slice(offset, offset + 1000), 'ids');
  });

  const filters: FilterInput[] = [
    { kind: 'in', column: 'category', values: ['alpha', 'echo'] },
    { kind: 'range', column: 'amount', min: 1000, max: 5000, maxInclusive: false },
  ];
  const matching = reference.filter((row) => (row.category === 'alpha' || row.category === 'echo') && row.amount >= 1000 && row.amount < 5000);

  await step('filtered page and count', async () => {
    const page = await engine.pageFetcher(table, { viewId: 'grid', filters })(0, 1000);
    same('filtered page', column(page.table, 'id'), matching.slice(0, 1000).map((row) => row.id), 'ids');
    const count = await engine.count(table, { viewId: 'status', filters });
    check('filtered count', count.rowCount === matching.length, `count ${count.rowCount} vs ${matching.length}`);
  });

  const aggregate = (spec: AggregateSpecInput, viewId: string) => engine.aggregate(table, spec, { viewId });

  await step('aggregate per mark', async () => {
    const bar = await aggregate({ mark: 'bar', x: { column: 'category' } }, 'chart:bar');
    same('bar', numbers(bar.table, 'y'), CATEGORIES.map((_, k) => reference.filter((__, i) => i % CATEGORIES.length === k).length), 'counts');
    const histogram = await aggregate({ mark: 'histogram', x: { column: 'amount', bin: 1000 } }, 'chart:histogram');
    check('histogram', sum(numbers(histogram.table, 'y')) === rows, 'bins sum to the row count');
    const line = await aggregate({ mark: 'line', x: { column: 'created_on', timeUnit: 'month' }, pixelWidth: 600 }, 'chart:line');
    check('line', line.table.numRows === 12 && sum(numbers(line.table, 'y')) === rows, `${line.table.numRows} months`);
    const area = await aggregate({ mark: 'area', x: { column: 'id' }, y: { column: 'amount', aggregate: 'sum' }, pixelWidth: 300 }, 'chart:area');
    check('area', area.table.numRows > 0 && area.table.numRows <= 4 * 300, `${area.table.numRows} M4 rows`);
    const heatmap = await aggregate({ mark: 'heatmap', x: { column: 'amount' }, y: { column: 'id' } }, 'chart:heatmap');
    check('heatmap', sum(numbers(heatmap.table, 'count')) === rows, 'cells sum to the row count');
    const scatter = await aggregate({ mark: 'scatter', x: { column: 'id' }, y: { column: 'amount' }, limit: 1000 }, 'chart:scatter');
    check('scatter', rows <= 1000 ? scatter.mark === 'scatter' : scatter.fellBackToHeatmap, `mark ${scatter.mark}`);
  });

  await step('cross-filter: cube answers equal plain answers', async () => {
    const dimension = { column: 'category', bin: { kind: 'value' as const } };
    const spec = { mark: 'histogram', x: { column: 'amount', bin: 1000 } } as const satisfies AggregateSpecInput;
    const prepared = await engine.prepareCrossfilter(table, { dimension, targets: [{ kind: 'aggregate', spec: { ...spec, filters: [] } }, { kind: 'count', filters: [] }] });
    check('prepare', prepared.cubes.every((cube) => cube.status === 'ready'), JSON.stringify(prepared.cubes));
    const brushed: FilterInput[] = [{ kind: 'in', column: 'category', values: ['bravo', 'delta'] }];
    const hint = { filter: 0, dimension };
    const fromCube = await engine.aggregate(table, { ...spec, filters: brushed }, { viewId: 'chart:cube', crossfilter: hint });
    const plain = await engine.aggregate(table, { ...spec, filters: brushed }, { viewId: 'chart:plain' });
    check('cube', fromCube.fromCube === true && plain.fromCube === false, 'answered from the cube');
    same('cube', numbers(fromCube.table, 'y'), numbers(plain.table, 'y'), 'histogram under the brush');
    const count = await engine.count(table, { viewId: 'status', filters: brushed, crossfilter: hint });
    check('cube count', count.fromCube === true && count.rowCount === reference.filter((row) => row.category === 'bravo' || row.category === 'delta').length, `count ${count.rowCount}`);
  });

  await step('setColumnTypes', async () => {
    const changed = await engine.setColumnTypes(table, [{ column: 'amount', type: 'text' }]);
    same('setColumnTypes', changed.columns, [{ column: 'amount', type: 'text', duckdbType: 'VARCHAR', failedCasts: 0 }], 'result');
    const page = await engine.pageFetcher(table)(0, 3);
    // DuckDB's DOUBLE-to-VARCHAR text, e.g. 0.0 for zero.
    same('setColumnTypes', column(page.table, 'amount'), ['0.0', '79.19', '158.38'], 'text cells');
    const reverted = await engine.setColumnTypes(table, []);
    check('setColumnTypes', reverted.table.columns.find((candidate) => candidate.name === 'amount')?.duckdbType === 'DOUBLE', 'reverted');
  });

  await step('abort', async () => {
    const controller = new AbortController();
    const pending = engine.pageFetcher(table, { viewId: 'grid', sort: [{ column: 'created_on', direction: 'desc' }, { column: 'category', direction: 'asc' }] })(
      Math.max(0, rows - 1000),
      1000,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 5);
    const outcome = await pending.then(
      () => 'resolved',
      (error: unknown) => (isAbandoned(error) ? 'abandoned' : `failed: ${String(error)}`),
    );
    check('abort', outcome === 'abandoned' || outcome === 'resolved', outcome);
    // The engine keeps serving after an abort.
    const count = await engine.count(table, { viewId: 'status' });
    check('abort', count.rowCount === rows, 'count after abort');
  });

  await step('closeTable', async () => {
    await engine.closeTable(table);
    // The id reopens on demand while the file stays registered.
    const count = await engine.count(table, { viewId: 'status' });
    check('closeTable', count.rowCount === rows, 'count after reopening');
  });

  return steps;
}

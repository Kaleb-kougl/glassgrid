/*
 * Cross-filter cubes in the engine, end to end with the core model: random
 * brushes on a workspace of linked charts over random data. Every view the
 * model hints at is answered twice, from its cube and as the plain query, and
 * the rows must match. Also: prepare at brush start, cube reuse across
 * brushes, invalidation on a type change, superseded requests, size limits.
 */
import { join } from 'node:path';
import type { Table } from 'apache-arrow';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorkspace,
  crossfilterPlan,
  viewQueries,
  type BrushSelectionInput,
  type CubeTarget,
  type EngineReply,
  type EngineResponse,
  type FileHandle,
  type TableId,
  type WorkspaceState,
} from '@glassgrid/core';
import { prepareCrossfilter, runAggregate, runCount, EngineSession } from './session';
import { createHarness, decode, hasParquet, mulberry32, writeLines, type Harness } from './test-support';

const ROWS = 3_000;
const SEED = 20261018;
const CATS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', "O'Brien", 'Other', '', 'zulu'];
const DAY = 86_400_000;
const T0 = Date.UTC(2024, 2, 1);

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** Random rows with NULLs, ties and values on awkward bin edges (dec is c/100, binned by 0.1). */
function* lines(rows: number): Generator<string> {
  const random = mulberry32(SEED);
  const maybe = (p: number, value: () => string) => (random() < p ? '' : value());
  for (let i = 0; i < rows; i += 1) {
    const ts = maybe(0.03, () => stamp(T0 + Math.floor(random() * 20 * DAY / 60_000) * 60_000));
    const d = stamp(T0 + Math.floor(random() * 120) * DAY).slice(0, 10);
    const num = maybe(0.05, () => String(Math.floor(random() * 641 - 320) / 8));
    const dec = (Math.floor(random() * 1001 - 500) / 100).toFixed(2);
    const n = maybe(0.02, () => String(Math.floor(random() ** 2 * 41)));
    const cat = maybe(0.05, () => {
      const value = CATS[Math.floor(random() ** 1.5 * CATS.length)] ?? 'alpha';
      return value.includes("'") || value === '' ? `"${value}"` : value;
    });
    const flag = random() < 0.4 ? 'true' : 'false';
    yield `${ts},${d},${num},${dec},${n},${cat},${flag}`;
  }
}

let h: Harness;
let file: FileHandle;
let table: TableId;
let parquetFile: FileHandle;
let parquetTable: TableId;

beforeAll(async () => {
  h = await createHarness();
  const path = join(h.dir, 'xf.csv');
  await writeLines(path, 'ts,d,num,dec,n,cat,flag', lines(ROWS));
  ({ file, table } = h.register(path));
  ({ file: parquetFile, table: parquetTable } = h.register(path));
  await h.service.open(file, { parquet: 'never' });
  await h.service.open(parquetFile, { parquet: 'never' });
  if (hasParquet) await h.service.ensureParquetCache(parquetTable);
});

afterAll(async () => {
  await h.dispose();
});

const CHARTS: unknown[] = [
  { columns: ['num'] },
  { columns: ['cat'] },
  { spec: { mark: 'bar', x: { column: 'cat' }, y: { column: 'num', aggregate: 'sum' }, color: { column: 'flag' }, limit: 4, other: true } },
  { columns: ['ts'] },
  { spec: { mark: 'line', x: { column: 'ts', timeUnit: 'day' }, y: { column: 'num', aggregate: 'avg' }, color: { column: 'cat' } } },
  { spec: { mark: 'area', x: { column: 'd' }, y: { column: 'ts', aggregate: 'max' } } },
  { columns: ['num', 'n'] },
  { spec: { mark: 'histogram', x: { column: 'dec', bin: 0.1 }, y: { column: 'n', aggregate: 'count' } } },
  { spec: { mark: 'bar', x: { column: 'n' }, y: { column: 'dec', aggregate: 'min' }, limit: 50 } },
  { spec: { mark: 'scatter', x: { column: 'num' }, y: { column: 'dec' } } },
];

/** A workspace over `id` with every chart above and the engine's profile recorded. */
async function workspaceFor(id: TableId, handle: FileHandle) {
  const workspace = createWorkspace({ clock: () => 0, newId: (() => { let n = 0; return (prefix: string) => `${prefix}_${++n}`; })() });
  const opened = await h.service.open(handle);
  await workspace.registry.dispatch(
    'openFile',
    { handleId: handle, fileName: 'xf.csv', fingerprint: opened.fingerprint, columns: opened.columns.map((c) => ({ name: c.name, type: c.type })) },
    { caller: 'user' },
  );
  const profile = (await h.service.profile(id)).value;
  await workspace.registry.dispatch(
    'setColumnProfiles',
    { columns: profile.columns.map(({ name, type, distinctCount, nullFraction, min, max }) => ({ name, type, distinctCount, nullFraction, min, max })) },
    { caller: 'user' },
  );
  for (const chart of CHARTS) await workspace.registry.dispatch('addChart', chart, { caller: 'user' });
  return workspace;
}

/** A gesture a person could make on chart `index` (or the grid, index -1). */
function gestureArb(state: WorkspaceState): fc.Arbitrary<{ viewId: string; selection: BrushSelectionInput }> {
  const ids = state.charts.map((chart) => chart.id);
  const id = (i: number) => ids[i] ?? 'missing';
  const range = (lo: number, hi: number) => fc.tuple(fc.double({ min: lo, max: hi, noNaN: true }), fc.double({ min: lo, max: hi, noNaN: true }));
  const time = (lo: number, hi: number) => fc.tuple(fc.integer({ min: lo, max: hi }), fc.integer({ min: lo, max: hi }));
  const catValues = fc.uniqueArray(fc.constantFrom<string | null>(...CATS, null), { minLength: 1, maxLength: 4 });
  return fc.oneof(
    range(-45, 45).map(([a, b]) => ({ viewId: id(0), selection: { type: 'interval' as const, x: { min: a, max: b } } })),
    catValues.map((values) => ({ viewId: id(1), selection: { type: 'points' as const, values } })),
    fc
      .tuple(catValues, fc.boolean())
      .map(([values, other]) => ({
        viewId: id(2),
        selection: other
          ? { type: 'points' as const, values: values.slice(0, 1), other: { shown: ['alpha', 'bravo', 'charlie', 'delta'] } }
          : { type: 'points' as const, values },
      })),
    time(T0 - DAY, T0 + 21 * DAY).map(([a, b]) => ({ viewId: id(3), selection: { type: 'interval' as const, x: { min: a, max: b } } })),
    time(T0, T0 + 20 * DAY).map(([a, b]) => ({ viewId: id(4), selection: { type: 'interval' as const, x: { min: a, max: b } } })),
    time(T0, T0 + 120 * DAY).map(([a, b]) => ({ viewId: id(5), selection: { type: 'interval' as const, x: { min: a, max: b } } })),
    fc
      .tuple(range(-45, 45), fc.option(range(0, 40), { nil: undefined }))
      .map(([[a, b], y]) => ({
        viewId: id(6),
        selection: { type: 'interval' as const, x: { min: a, max: b }, ...(y ? { y: { min: y[0], max: y[1] } } : {}) },
      })),
    range(-5.2, 5.2).map(([a, b]) => ({ viewId: id(7), selection: { type: 'interval' as const, x: { min: a, max: b } } })),
    fc.uniqueArray(fc.integer({ min: 0, max: 40 }), { minLength: 1, maxLength: 5 }).map((values) => ({ viewId: id(8), selection: { type: 'points' as const, values } })),
    range(-45, 45).map(([a, b]) => ({ viewId: id(9), selection: { type: 'interval' as const, x: { min: a, max: b } } })),
    catValues.map((values) => ({ viewId: 'grid', selection: { type: 'points' as const, column: 'cat', values } })),
    range(-1, 41).map(([a, b]) => ({ viewId: 'grid', selection: { type: 'interval' as const, column: 'n', x: { min: a, max: b } } })),
  );
}

type Row = Record<string, unknown>;

function rowsOf(arrow: Table): Row[] {
  return arrow.toArray().map((row: Record<string, unknown>) => {
    const out: Row = {};
    for (const field of arrow.schema.fields) {
      const value = row[field.name];
      out[field.name] = typeof value === 'bigint' ? Number(value) : value instanceof Date ? value.getTime() : value;
    }
    return out;
  });
}

function sameRows(a: readonly Row[], b: readonly Row[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, i) => {
    const other = b[i] ?? {};
    const keys = Object.keys(other);
    return (
      Object.keys(row).length === keys.length &&
      keys.every((key) => {
        const x = row[key];
        const y = other[key];
        if (typeof x === 'number' && typeof y === 'number') return x === y || Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y));
        return Object.is(x, y);
      })
    );
  });
}

const stats = { compared: 0, fromCube: 0, countsFromCube: 0 };

async function checkBrush(id: TableId, state: WorkspaceState, activeView: string): Promise<void> {
  const queries = viewQueries(state, { activeView });
  for (const query of queries.charts) {
    const spec = { ...query.spec, pixelWidth: 300 };
    const plain = await runAggregate(h.service, id, spec, {});
    const hinted = await runAggregate(h.service, id, spec, {}, query.crossfilter ?? undefined);
    stats.compared += 1;
    if (hinted.fromCube) stats.fromCube += 1;
    const actual = rowsOf(decode(hinted.value));
    const expected = rowsOf(decode(plain.value));
    if (!sameRows(actual, expected)) {
      expect.fail(`${JSON.stringify(query.spec)}\nhint ${JSON.stringify(query.crossfilter)}\ncube:  ${JSON.stringify(actual)}\nplain: ${JSON.stringify(expected)}`);
    }
  }
  const plainCount = await runCount(h.service, id, queries.grid.filters, {});
  const hintedCount = await runCount(h.service, id, queries.grid.filters, {}, queries.grid.crossfilter ?? undefined);
  if (hintedCount.fromCube) stats.countsFromCube += 1;
  expect(hintedCount.value).toBe(plainCount.value);
}

describe('cross-filter cubes against plain queries (property)', () => {
  for (const source of hasParquet ? (['csv', 'parquet'] as const) : (['csv'] as const)) {
    it(`answers every hinted view exactly like the plain query (${source})`, { timeout: 300_000 }, async () => {
      const id = source === 'csv' ? table : parquetTable;
      const handle = source === 'csv' ? file : parquetFile;
      const { registry, store } = await workspaceFor(id, handle);
      const base = store.getState();
      await fc.assert(
        fc.asyncProperty(
          fc.array(gestureArb(base), { minLength: 1, maxLength: 3 }),
          fc.option(fc.constantFrom({ kind: 'notNull' as const, column: 'num' }, { kind: 'range' as const, column: 'n', min: 3, minInclusive: true, maxInclusive: true }), { nil: null }),
          async (gestures, userFilter) => {
            const { registry: r, store: s } = createWorkspace({ clock: () => 0, newId: (p) => `${p}_x`, initialState: base });
            if (userFilter) await r.dispatch('addFilter', { filter: userFilter }, { caller: 'user' });
            // Earlier gestures are other views' standing selections; the last one is the active brush.
            for (const gesture of gestures) await r.dispatch('brush', gesture, { caller: 'user' });
            const active = gestures.at(-1)?.viewId ?? 'grid';
            await checkBrush(id, s.getState(), active);
          },
        ),
        { seed: SEED, numRuns: source === 'csv' ? 60 : 25, endOnFailure: true },
      );
      expect(registry).toBeDefined();
      console.info(source, JSON.stringify(stats));
      expect(stats.fromCube).toBeGreaterThan(stats.compared / 3);
      expect(stats.countsFromCube).toBeGreaterThan(0);
    });
  }
});

describe('cube lifecycle', () => {
  it('prepare builds the cubes a brush needs; brushes on the same axis reuse them', async () => {
    const { registry, store } = await workspaceFor(table, file);
    const histogram = store.getState().charts[0]?.id ?? '';
    const plan = crossfilterPlan(store.getState(), histogram);
    if (!plan) throw new Error('no plan');
    const targets: CubeTarget[] = plan.targets.map((target) =>
      target.kind === 'aggregate' ? { kind: 'aggregate', spec: { ...target.spec, pixelWidth: 300 } } : { kind: 'count', filters: target.filters },
    );
    await h.service.clearCache('results');
    const prepared = await prepareCrossfilter(h.service, table, plan.dimension, targets, {});
    expect(prepared.map((cube) => cube.status)).toEqual(targets.map(() => 'ready'));
    const built = h.service.cubeStats().builds;

    for (const [min, max] of [
      [0, 10],
      [-20, 3],
      [5, 6],
    ] as const) {
      await registry.dispatch('brush', { viewId: histogram, selection: { type: 'interval', x: { min, max } } }, { caller: 'user' });
      const queries = viewQueries(store.getState(), { activeView: histogram });
      for (const query of queries.charts.filter((candidate) => candidate.chartId !== histogram)) {
        const outcome = await runAggregate(h.service, table, { ...query.spec, pixelWidth: 300 }, {}, query.crossfilter ?? undefined);
        expect(outcome.fromCube, query.spec.mark).toBe(query.spec.mark !== 'scatter');
      }
      const count = await runCount(h.service, table, queries.grid.filters, {}, queries.grid.crossfilter ?? undefined);
      expect(count.fromCube).toBe(true);
    }
    expect(h.service.cubeStats().builds).toBe(built);
  });

  it('drops cubes when column types change and answers with the new types', async () => {
    const { registry, store } = await workspaceFor(table, file);
    const bar = store.getState().charts[1]?.id ?? '';
    await registry.dispatch('brush', { viewId: bar, selection: { type: 'points', values: ['alpha'] } }, { caller: 'user' });
    const queries = viewQueries(store.getState(), { activeView: bar });
    const histogram = queries.charts[0];
    if (!histogram) throw new Error('no histogram');
    const before = await runAggregate(h.service, table, histogram.spec, {}, histogram.crossfilter ?? undefined);
    expect(before.fromCube).toBe(true);
    const cubesBefore = h.service.cubeStats().cubes;
    expect(cubesBefore).toBeGreaterThan(0);

    await h.service.setColumnTypes(table, [{ column: 'num', type: 'integer' }]);
    expect(h.service.cubeStats().cubes).toBe(0);
    const after = await runAggregate(h.service, table, histogram.spec, {}, histogram.crossfilter ?? undefined);
    const plain = await runAggregate(h.service, table, histogram.spec, {});
    expect(after.fromCube).toBe(true);
    expect(sameRows(rowsOf(decode(after.value)), rowsOf(decode(plain.value)))).toBe(true);
    await h.service.setColumnTypes(table, []);
  });

  it('skips cubes that would be too large, unaligned selections and scatter plots', async () => {
    const dimension = { column: 'ts', bin: { kind: 'value' as const } };
    const prepared = await prepareCrossfilter(
      h.service,
      table,
      dimension,
      [
        { kind: 'aggregate', spec: { mark: 'bar', x: { column: 'cat' }, filters: [] } },
        { kind: 'aggregate', spec: { mark: 'scatter', x: { column: 'num' }, y: { column: 'dec' }, filters: [] } },
        { kind: 'count', filters: [] },
      ],
      {},
    );
    // ts has ~2,900 distinct values: small enough here, so the bar and the count get cubes.
    expect(prepared.map((cube) => cube.status)).toEqual(['ready', 'skipped', 'ready']);
    expect(prepared[1]).toMatchObject({ reason: 'scatter plots raw points' });

    const unaligned = await runAggregate(
      h.service,
      table,
      { mark: 'bar', x: { column: 'cat' }, filters: [{ kind: 'range', column: 'num', min: 0.3, max: 2, minInclusive: true, maxInclusive: false }] },
      {},
      { filter: 0, dimension: { column: 'num', bin: { kind: 'width', width: 1 } } },
    );
    expect(unaligned.fromCube).toBe(false);
    const badIndex = await runAggregate(h.service, table, { mark: 'bar', x: { column: 'cat' }, filters: [] }, {}, { filter: 3, dimension });
    expect(badIndex.fromCube).toBe(false);
  });

  it('a superseded aggregate does not stop its cube build; the next brush is answered from it', async () => {
    const sent: EngineResponse[] = [];
    const session = new EngineSession(Promise.resolve(h.service), (message) => sent.push(message));
    let next = 0;
    const send = (body: Record<string, unknown>) => {
      next += 1;
      const requestId = `s${next}`;
      session.handle({ ...body, requestId });
      return requestId;
    };
    const reply = async (requestId: string): Promise<EngineReply> => {
      for (let waited = 0; waited < 60_000; waited += 2) {
        const found = sent.find((m): m is EngineReply => m.kind !== 'event' && m.requestId === requestId);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      throw new Error(`no reply to ${requestId}`);
    };
    await h.service.clearCache('results');
    const spec = { mark: 'histogram', x: { column: 'dec', bin: 0.5 }, filters: [{ kind: 'in', column: 'flag', values: [true] }] };
    const hint = { filter: 0, dimension: { column: 'flag', bin: { kind: 'value' } } };
    const first = send({ kind: 'aggregate', viewId: 'chart:c', seq: 1, table, spec, crossfilter: hint });
    const second = send({ kind: 'aggregate', viewId: 'chart:c', seq: 2, table, spec: { ...spec, filters: [{ kind: 'in', column: 'flag', values: [false] }] }, crossfilter: hint });
    const answer = await reply(second);
    expect(answer).toMatchObject({ kind: 'aggregate', fromCube: true });
    // The first was superseded silently (no reply), and the cube was built once.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent.some((m) => m.kind !== 'event' && m.requestId === first)).toBe(false);
    session.dispose();
  });
});

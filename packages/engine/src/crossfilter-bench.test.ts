import { mkdir, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createWorkspace,
  crossfilterPlan,
  viewQueries,
  type CommandRegistry,
  type EngineReply,
  type EngineRequest,
  type EngineResponse,
  type TableId,
  type WorkspaceStore,
} from '@glassgrid/core';
import { EngineSession } from './session';
import { createHarness, mulberry32, writeTaxiLikeCsv } from './test-support';

/*
 * Cross-filter benchmark (opt-in): four linked charts and the grid over a
 * taxi-like table, brushed 20 times on the trip_distance histogram, driven
 * by the core model exactly as the app will drive it:
 *
 *   pointer down  → crossfilterPlan → prepareCrossfilter   (cube mode only)
 *   drag          → 300 ms of local UI state, no queries
 *   pointer up    → `brush` command → viewQueries(state, { activeView })
 *                 → the 3 other charts' aggregates, the grid's count and its
 *                   first page, all at once through an EngineSession (the
 *                   real request path minus the MessagePort)
 *
 * The timing per brush is from the commit to the last of those five
 * replies. `sql` mode sends no cross-filter hints (M2 behaviour); `cube` mode
 * sends them, so the engine answers from per-chart cubes.
 *
 *   GLASSGRID_XF_BENCH_ROWS=10000000 pnpm --filter @glassgrid/engine exec vitest run --project native src/crossfilter-bench.test.ts
 *
 * GLASSGRID_XF_BENCH_CSV=<path> reuses (or creates) the fixture file;
 * GLASSGRID_XF_MODES=sql,cube picks the modes; GLASSGRID_XF_SOURCES=parquet,csv
 * the table sources; GLASSGRID_BENCH_LABEL tags the JSON in e2e-results/.
 */
const ROWS = Number(process.env['GLASSGRID_XF_BENCH_ROWS'] ?? 0);
const CSV = process.env['GLASSGRID_XF_BENCH_CSV'];
const LABEL = process.env['GLASSGRID_BENCH_LABEL'] ?? '';
const MODES = (process.env['GLASSGRID_XF_MODES'] ?? 'sql,cube').split(',') as ('sql' | 'cube')[];
const SOURCES = (process.env['GLASSGRID_XF_SOURCES'] ?? 'parquet,csv').split(',') as ('parquet' | 'csv')[];
const BRUSHES = 20;
const DRAG_MS = 300;
const GAP_MS = 300;
const PIXEL_WIDTH = 600;

const round = (ms: number) => Math.round(ms * 10) / 10;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

type Body = EngineRequest extends infer R ? (R extends EngineRequest ? Omit<R, 'requestId'> : never) : never;

/** Promise-based wrapper around an in-process EngineSession with per-view sequence numbers. */
function connect(session: EngineSession, replies: Map<string, (reply: EngineReply) => void>) {
  let next = 0;
  const seqs = new Map<string, number>();
  return (body: Body): Promise<EngineReply> => {
    next += 1;
    const requestId = `b${next}`;
    const request = { ...body, requestId };
    if ('viewId' in request && 'seq' in request && !(request.kind === 'rows' && request.concurrent === true)) {
      const seq = (seqs.get(request.viewId) ?? 0) + 1;
      seqs.set(request.viewId, seq);
      request.seq = seq;
    }
    return new Promise((resolvePromise) => {
      replies.set(requestId, resolvePromise);
      session.handle(request);
    });
  };
}

function ok(reply: EngineReply): EngineReply {
  if (reply.kind === 'error') throw new Error(`${reply.code}: ${reply.message}`);
  return reply;
}

interface Run {
  initialRenderMs: number;
  prepareMs: number | null;
  cubes: unknown;
  brushMs: number[];
  firstBrushMs: number;
  p50: number;
  p95: number;
  max: number;
  steadyP50: number;
  steadyP95: number;
  perViewP50: Record<string, number>;
  perViewP95: Record<string, number>;
  fromCube: number;
  answered: number;
}

async function brushRun(
  call: (body: Body) => Promise<EngineReply>,
  table: TableId,
  registry: CommandRegistry,
  store: WorkspaceStore,
  mode: 'sql' | 'cube',
): Promise<Run> {
  const charts = store.getState().charts;
  const distance = charts[0]?.id ?? '';
  const pixel = <T extends object>(spec: T) => ({ ...spec, pixelWidth: PIXEL_WIDTH });

  // The initial render: every chart, the count and the first page, no selection.
  await registry.dispatch('brush', { viewId: distance, selection: null }, { caller: 'user' });
  const started = performance.now();
  const initial = viewQueries(store.getState());
  await Promise.all([
    ...initial.charts.map((query) => call({ kind: 'aggregate', viewId: query.engineViewId, seq: 0, table, spec: pixel(query.spec) })),
    call({ kind: 'count', viewId: 'status', seq: 0, table, filters: initial.grid.filters }),
    call({ kind: 'rows', viewId: 'grid', seq: 0, table, query: { offset: 0, limit: 1000 }, filters: initial.grid.filters, concurrent: true }),
  ]).then((all) => all.map(ok));
  const initialRenderMs = performance.now() - started;

  const random = mulberry32(7);
  const brushes: number[] = [];
  const perView: Record<string, number[]> = {};
  let prepareMs: number | null = null;
  let cubes: unknown = null;
  let fromCube = 0;
  let answered = 0;
  for (let i = 0; i < BRUSHES; i += 1) {
    // Pointer down: in cube mode, ask for the cubes this brush needs (instant once they exist).
    if (mode === 'cube') {
      const plan = crossfilterPlan(store.getState(), distance);
      if (!plan) throw new Error('no cross-filter plan');
      const prepareStarted = performance.now();
      void call({
        kind: 'prepareCrossfilter',
        viewId: 'brush',
        seq: 0,
        table,
        dimension: plan.dimension,
        targets: plan.targets.map((target) =>
          target.kind === 'aggregate' ? { kind: 'aggregate' as const, spec: pixel(target.spec) } : { kind: 'count' as const, filters: target.filters },
        ),
      }).then((reply) => {
        if (prepareMs === null && reply.kind === 'crossfilterPrepared') {
          prepareMs = round(performance.now() - prepareStarted);
          cubes = reply.cubes;
        }
      });
    }
    await sleep(DRAG_MS);

    // Pointer up: commit the brush (somewhere in the first 30 units of distance, 0.5 to 12 units wide).
    const min = random() * 30;
    const max = min + 0.5 + random() * 12;
    await registry.dispatch('brush', { viewId: distance, selection: { type: 'interval', x: { min, max } } }, { caller: 'user' });
    const queries = viewQueries(store.getState(), { activeView: distance });
    const t0 = performance.now();
    const timed = (view: string, promise: Promise<EngineReply>) =>
      promise.then((reply) => {
        (perView[view] ??= []).push(performance.now() - t0);
        const result = ok(reply);
        if (result.kind === 'aggregate' || result.kind === 'count') {
          answered += 1;
          if (result.fromCube === true) fromCube += 1;
        }
        return result;
      });
    await Promise.all([
      ...queries.charts
        .filter((query) => query.chartId !== distance)
        .map((query) =>
          timed(
            query.chartId,
            call({
              kind: 'aggregate',
              viewId: query.engineViewId,
              seq: 0,
              table,
              spec: pixel(query.spec),
              ...(mode === 'cube' && query.crossfilter ? { crossfilter: query.crossfilter } : {}),
            }),
          ),
        ),
      timed(
        'count',
        call({
          kind: 'count',
          viewId: 'status',
          seq: 0,
          table,
          filters: queries.grid.filters,
          ...(mode === 'cube' && queries.grid.crossfilter ? { crossfilter: queries.grid.crossfilter } : {}),
        }),
      ),
      timed(
        'firstPage',
        call({ kind: 'rows', viewId: 'grid', seq: 0, table, query: { offset: 0, limit: 1000 }, filters: queries.grid.filters, concurrent: true }),
      ),
    ]);
    brushes.push(performance.now() - t0);
    await sleep(GAP_MS);
  }
  const names = new Map(charts.map((chart, index) => [chart.id, ['distance', 'payment', 'pickups', 'zones'][index] ?? chart.id]));
  const label = (view: string) => names.get(view) ?? view;
  const steady = brushes.slice(1);
  return {
    initialRenderMs: round(initialRenderMs),
    prepareMs,
    cubes,
    brushMs: brushes.map(round),
    firstBrushMs: round(brushes[0] ?? 0),
    p50: round(percentile(brushes, 50)),
    p95: round(percentile(brushes, 95)),
    max: round(Math.max(...brushes)),
    steadyP50: round(percentile(steady, 50)),
    steadyP95: round(percentile(steady, 95)),
    perViewP50: Object.fromEntries(Object.entries(perView).map(([view, values]) => [label(view), round(percentile(values, 50))])),
    perViewP95: Object.fromEntries(Object.entries(perView).map(([view, values]) => [label(view), round(percentile(values, 95))])),
    fromCube,
    answered,
  };
}

describe.skipIf(!(ROWS > 0))('cross-filter benchmark', () => {
  it(`brushes a histogram ${BRUSHES} times over ${ROWS} rows`, { timeout: 60 * 60_000 }, async () => {
    const h = await createHarness();
    const results: Record<string, Run> = {};
    try {
      const path = CSV ?? join(h.dir, 'taxi-like.csv');
      if (!(await stat(path).catch(() => null))) await writeTaxiLikeCsv(path, ROWS);
      const { file, table } = h.register(path);

      for (const source of SOURCES) {
        for (const mode of MODES) {
          const service = await h.restart();
          service.registerFile(file, path);
          if (source === 'parquet') {
            await service.open(file, { parquet: 'never' });
            await service.ensureParquetCache(table);
          } else {
            await service.clearCache('all');
          }
          const replies = new Map<string, (reply: EngineReply) => void>();
          const session = new EngineSession(Promise.resolve(service), (message: EngineResponse) => {
            if (message.kind === 'event' || message.requestId === null) return;
            replies.get(message.requestId)?.(message);
            replies.delete(message.requestId);
          });
          const call = connect(session, replies);
          const opened = ok(await call({ kind: 'open', file, parquet: source === 'csv' ? 'never' : 'auto' }));
          if (opened.kind !== 'opened') throw new Error('expected opened');
          expect(opened.table.usingParquetCache).toBe(source === 'parquet');
          const profile = ok(await call({ kind: 'profile', viewId: 'profile', seq: 0, table }));
          if (profile.kind !== 'profile') throw new Error('expected a profile');

          const { registry, store } = createWorkspace({ clock: () => Date.now(), newId: (prefix) => `${prefix}_${Math.random().toString(36).slice(2, 10)}` });
          await registry.dispatch(
            'openFile',
            {
              handleId: file,
              fileName: 'taxi-like.csv',
              fingerprint: opened.table.fingerprint,
              columns: opened.table.columns.map((column) => ({ name: column.name, type: column.type })),
            },
            { caller: 'user' },
          );
          await registry.dispatch(
            'setColumnProfiles',
            { columns: profile.columns.map(({ name, type, distinctCount, nullFraction, min, max }) => ({ name, type, distinctCount, nullFraction, min, max })) },
            { caller: 'user' },
          );
          // Default charts from the column profile, plus a top-20 + Other bar of a sum.
          await registry.dispatch('addChart', { columns: ['trip_distance'] }, { caller: 'user' });
          await registry.dispatch('addChart', { columns: ['payment_type'] }, { caller: 'user' });
          await registry.dispatch('addChart', { columns: ['pickup_datetime'] }, { caller: 'user' });
          await registry.dispatch(
            'addChart',
            { spec: { mark: 'bar', x: { column: 'PULocationID' }, y: { column: 'fare_amount', aggregate: 'sum' }, limit: 20, other: true } },
            { caller: 'user' },
          );

          const run = await brushRun(call, table, registry, store, mode);
          results[`${source}.${mode}`] = run;
          console.info(`${source}.${mode}`, JSON.stringify({ ...run, brushMs: undefined, cubes: undefined }));
          session.dispose();
        }
      }

      const out = {
        benchmark: 'crossfilter',
        label: LABEL,
        recordedAt: new Date().toISOString(),
        rows: ROWS,
        brushes: BRUSHES,
        dragMs: DRAG_MS,
        gapMs: GAP_MS,
        machine: {
          platform: platform(),
          arch: arch(),
          cpuModel: cpus()[0]?.model ?? 'unknown',
          cpuCount: cpus().length,
          totalMemBytes: totalmem(),
        },
        results,
      };
      const outDir = resolve(import.meta.dirname, '../../e2e-results');
      await mkdir(outDir, { recursive: true });
      const suffix = LABEL ? `-${LABEL}` : '';
      await writeFile(join(outDir, `crossfilter-bench-${ROWS}-${platform()}-${arch()}${suffix}.json`), `${JSON.stringify(out, null, 2)}\n`);
    } finally {
      await h.dispose();
    }
  });
});

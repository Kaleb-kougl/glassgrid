import type { AggregateSpecInput, FileHandle, FilterInput, ParquetMode } from '@glassgrid/core';
import type { EngineClientApi } from '../client/types';

/*
 * The M4 engine workload (docs/benchmarks/m4/): one cold pass over a table
 * through the client API, timed from the caller's side (transport
 * included), on the synthetic dataset (tools/datasets, `synthetic-<n>-seed42`).
 * Runtime-neutral, so the browser page (DuckDB-WASM in a Web Worker) and the
 * Node bench (native DuckDB and DuckDB-WASM behind a MessagePort) run the
 * exact same requests.
 */

export interface WorkloadTimings {
  /** open request → first 1,000 rows decoded. */
  openToFirstPageMs: number;
  openMs: number;
  firstPageMs: number;
  profileMs: number;
  /** First page sorted by amount descending (top-K block). */
  sortedFirstPageMs: number;
  /** Bar of row counts per region. */
  barMs: number;
  /** Heatmap of latitude x longitude (auto bins). */
  heatmapMs: number;
  /** Brush start: the cubes for the heatmap, an amount histogram and the count, by region. */
  crossfilterPrepareMs: number;
  /** One brush on region: the heatmap, the histogram and the count from their cubes. */
  brushMs: number;
  /** The same brush answered by plain SQL (no hint), for comparison. */
  brushPlainMs: number;
  rows: number;
  fromCube: boolean;
}

const HEATMAP = { mark: 'heatmap', x: { column: 'longitude', bin: 'auto' }, y: { column: 'latitude', bin: 'auto' } } as const satisfies AggregateSpecInput;
const HISTOGRAM = { mark: 'histogram', x: { column: 'discount_pct', bin: 1 } } as const satisfies AggregateSpecInput;

export async function runWorkload(engine: EngineClientApi, file: FileHandle, options: { parquet?: ParquetMode } = {}): Promise<WorkloadTimings> {
  const now = () => performance.now();
  const t0 = now();
  const opened = await engine.open(file, { parquet: options.parquet ?? 'never' });
  const t1 = now();
  const table = opened.table.id;
  await engine.pageFetcher(table)(0, 1000);
  const t2 = now();

  const profile = await engine.profile(table, { viewId: 'profile' });
  const t3 = now();
  await engine.pageFetcher(table, { viewId: 'grid', sort: [{ column: 'amount', direction: 'desc' }] })(0, 1000);
  const t4 = now();
  await engine.aggregate(table, { mark: 'bar', x: { column: 'region' } }, { viewId: 'chart:bar' });
  const t5 = now();
  await engine.aggregate(table, { ...HEATMAP, pixelWidth: 600 }, { viewId: 'chart:heatmap' });
  const t6 = now();

  const dimension = { column: 'region', bin: { kind: 'value' as const } };
  await engine.prepareCrossfilter(table, {
    dimension,
    targets: [
      { kind: 'aggregate', spec: { ...HEATMAP, filters: [], pixelWidth: 600 } },
      { kind: 'aggregate', spec: { ...HISTOGRAM, filters: [], pixelWidth: 600 } },
      { kind: 'count', filters: [] },
    ],
  });
  const t7 = now();
  const brushed: FilterInput[] = [{ kind: 'in', column: 'region', values: ['eu-west', 'ap-south'] }];
  const hint = { filter: 0, dimension };
  const answers = await Promise.all([
    engine.aggregate(table, { ...HEATMAP, pixelWidth: 600, filters: brushed }, { viewId: 'chart:heatmap', crossfilter: hint }),
    engine.aggregate(table, { ...HISTOGRAM, pixelWidth: 600, filters: brushed }, { viewId: 'chart:histogram', crossfilter: hint }),
    engine.count(table, { viewId: 'status', filters: brushed, crossfilter: hint }),
  ]);
  const t8 = now();
  const otherBrush: FilterInput[] = [{ kind: 'in', column: 'region', values: ['us-west', 'sa-east'] }];
  await Promise.all([
    engine.aggregate(table, { ...HEATMAP, pixelWidth: 600, filters: otherBrush }, { viewId: 'chart:heatmap' }),
    engine.aggregate(table, { ...HISTOGRAM, pixelWidth: 600, filters: otherBrush }, { viewId: 'chart:histogram' }),
    engine.count(table, { viewId: 'status', filters: otherBrush }),
  ]);
  const t9 = now();

  const round = (ms: number) => Math.round(ms * 10) / 10;
  return {
    openToFirstPageMs: round(t2 - t0),
    openMs: round(t1 - t0),
    firstPageMs: round(t2 - t1),
    profileMs: round(t3 - t2),
    sortedFirstPageMs: round(t4 - t3),
    barMs: round(t5 - t4),
    heatmapMs: round(t6 - t5),
    crossfilterPrepareMs: round(t7 - t6),
    brushMs: round(t8 - t7),
    brushPlainMs: round(t9 - t8),
    rows: profile.rowCount,
    fromCube: answers.every((answer) => answer.fromCube === true),
  };
}

/** Medians per field over several runs. */
export function medians(runs: readonly WorkloadTimings[]): WorkloadTimings {
  const first = runs[0];
  if (!first) throw new Error('No runs');
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  };
  const out = { ...first };
  for (const key of Object.keys(first) as (keyof WorkloadTimings)[]) {
    if (typeof first[key] === 'number') (out[key] as number) = Math.round(median(runs.map((run) => run[key] as number)) * 10) / 10;
  }
  out.fromCube = runs.every((run) => run.fromCube);
  return out;
}

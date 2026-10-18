import type { Table } from 'apache-arrow';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChartViewQuery, Mark, TableId } from '@glassgrid/core';
import { isAbandoned, type EngineClientLike } from '../engine';
import { AGGREGATE_MEASURE, type AggregateMeasureDetail } from '../perf';
import { renderPerf } from '../render-perf-core';

/** One chart aggregate as the card shows it. */
export interface ChartResult {
  /** The request key it answers (see `chartRequestKey`). */
  readonly key: string;
  /** `viewQueries` key of the query (for the cross-filter timing). */
  readonly queryKey: string;
  readonly table: Table;
  /** The mark the rows are shaped for (`heatmap` when a scatter fell back). */
  readonly mark: Mark;
  readonly fellBackToHeatmap: boolean;
  readonly fromCube: boolean;
  readonly engineMs: number;
  readonly cached: boolean;
}

export type ChartData =
  | { readonly status: 'loading'; readonly previous: ChartResult | null }
  | { readonly status: 'ready'; readonly result: ChartResult }
  | { readonly status: 'error'; readonly message: string; readonly path: string | undefined; readonly previous: ChartResult | null };

/** Marks whose query depends on the plot width (M4 per pixel column, automatic numeric bins). */
export function usesPixelWidth(mark: Mark): boolean {
  return mark === 'line' || mark === 'area';
}

/** What a chart card's aggregate depends on: table, the query's inputs, plot width (lines) and data version. */
export function chartRequestKey(tableId: TableId | null, query: Pick<ChartViewQuery, 'key' | 'spec'>, pixelWidth: number, dataVersion: number): string {
  return JSON.stringify([tableId, query.key, usesPixelWidth(query.spec.mark) ? pixelWidth : null, dataVersion]);
}

function measure(start: string, detail: AggregateMeasureDetail): void {
  const end = `${AGGREGATE_MEASURE}:end`;
  performance.mark(end);
  performance.measure(AGGREGATE_MEASURE, { start, end, detail });
  performance.clearMarks(start);
  performance.clearMarks(end);
}

/**
 * Runs one chart card's aggregate whenever its inputs change: the spec with
 * every other view's selection (`viewQueries`), the plot width for lines and
 * the data version. Requests are view scoped (`chart:<id>`), so a newer one
 * supersedes a stale one in the engine; a late reply of a superseded request
 * is ignored here. The cross-filter hint is sent as it is at request time
 * but is not part of the key (it never changes the answer).
 */
export function useChartQuery(
  engine: Pick<EngineClientLike, 'aggregate'>,
  tableId: TableId | null,
  query: ChartViewQuery,
  pixelWidth: number,
  dataVersion: number,
): ChartData {
  const requestKey = chartRequestKey(tableId, query, pixelWidth, dataVersion);
  const [data, setData] = useState<{ key: string; value: ChartData } | null>(null);
  const latest = useRef({ query, pixelWidth });
  useLayoutEffect(() => {
    latest.current = { query, pixelWidth };
  });

  useEffect(() => {
    if (tableId === null) return;
    const live = { current: true };
    const { query: current, pixelWidth: width } = latest.current;
    const start = `${AGGREGATE_MEASURE}:start:${current.chartId}:${performance.now()}`;
    performance.mark(start);
    if (__GG_RENDER_PERF__) renderPerf.query(current.engineViewId);
    engine
      .aggregate(tableId, { ...current.spec, pixelWidth: width }, { viewId: current.engineViewId, ...(current.crossfilter ? { crossfilter: current.crossfilter } : {}) })
      .then(
        (result) => {
          if (!live.current) return;
          if (__GG_RENDER_PERF__) renderPerf.resolved(current.engineViewId);
          measure(start, { engineMs: result.engineMs, cached: result.cached, mark: result.mark, rows: result.table.numRows });
          const value: ChartResult = {
            key: requestKey,
            queryKey: current.key,
            table: result.table,
            mark: result.mark,
            fellBackToHeatmap: result.fellBackToHeatmap,
            fromCube: result.fromCube === true,
            engineMs: result.engineMs,
            cached: result.cached,
          };
          setData({ key: requestKey, value: { status: 'ready', result: value } });
        },
        (error: unknown) => {
          performance.clearMarks(start);
          if (!live.current || isAbandoned(error)) return;
          const message = error instanceof Error ? error.message : String(error);
          const path = typeof error === 'object' && error !== null && 'path' in error ? (error as { path?: string }).path : undefined;
          setData((before) => ({ key: requestKey, value: { status: 'error', message, path, previous: before ? lastResult(before.value) : null } }));
        },
      );
    return () => {
      live.current = false;
    };
    // requestKey captures the table, the query's inputs, the plot width (lines) and the data version.
  }, [engine, tableId, requestKey]);

  if (data?.key === requestKey) return data.value;
  return { status: 'loading', previous: data ? lastResult(data.value) : null };
}

function lastResult(data: ChartData): ChartResult | null {
  return data.status === 'ready' ? data.result : data.previous;
}

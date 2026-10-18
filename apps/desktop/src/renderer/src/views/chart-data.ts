import { useEffect, useState } from 'react';
import type { ChartSpec, Filter, TableId } from '@glassgrid/core';
import { filterValue, formatterFor, valueKind, type BarDatum } from '@glassgrid/ui';
import { isAbandoned, type EngineClient } from '../engine-client';
import { AGGREGATE_MEASURE, type AggregateMeasureDetail } from '../perf';
import type { FilterValue } from '@glassgrid/core';

export interface BarRow extends BarDatum {
  /** The x value as an `in` filter value. */
  readonly filterValue: FilterValue;
}

export type ChartData =
  | { readonly status: 'loading'; readonly previous: readonly BarRow[] | null }
  | { readonly status: 'ready'; readonly rows: readonly BarRow[]; readonly engineMs: number; readonly cached: boolean }
  | { readonly status: 'error'; readonly message: string; readonly path: string | undefined };

/** JSON identity of a filter value, used as the bar's key and to match selections. */
export function valueKey(value: FilterValue): string {
  return JSON.stringify(value);
}

function measure(start: string, detail: AggregateMeasureDetail): void {
  const end = `${AGGREGATE_MEASURE}:end`;
  performance.mark(end);
  performance.measure(AGGREGATE_MEASURE, { start, end, detail });
  performance.clearMarks(start);
  performance.clearMarks(end);
}

/**
 * Runs one chart card's aggregate (`viewId: chart:<id>`) whenever its spec,
 * the cross-filters from other views or the table change, so a newer request
 * supersedes the stale one.
 */
export function useChartData(
  engine: Pick<EngineClient, 'aggregate'>,
  tableId: TableId | null,
  chartId: string,
  spec: ChartSpec,
  crossFilters: readonly Filter[],
  dataVersion = 0,
): ChartData {
  const requestKey = JSON.stringify([tableId, spec, crossFilters, dataVersion]);
  const [data, setData] = useState<{ key: string; value: ChartData } | null>(null);

  useEffect(() => {
    if (tableId === null) return;
    const live = { current: true };
    const start = `${AGGREGATE_MEASURE}:start:${chartId}:${performance.now()}`;
    performance.mark(start);
    engine
      .aggregate(tableId, { ...spec, filters: [...spec.filters, ...crossFilters] }, { viewId: `chart:${chartId}` })
      .then(
        (result) => {
          if (!live.current) return;
          measure(start, { engineMs: result.engineMs, cached: result.cached, mark: result.mark, rows: result.table.numRows });
          const fields = result.table.schema.fields;
          const xIndex = fields.findIndex((field) => field.name === 'x');
          const yIndex = fields.findIndex((field) => field.name === 'y');
          const xVector = result.table.getChildAt(xIndex);
          const yVector = result.table.getChildAt(yIndex);
          const kind = valueKind(fields[xIndex]);
          const format = formatterFor(kind);
          const rows: BarRow[] = [];
          for (let i = 0; i < result.table.numRows; i += 1) {
            const raw: unknown = xVector?.get(i);
            const fv = filterValue(raw, kind);
            const y: unknown = yVector?.get(i);
            const label = format(raw);
            rows.push({
              key: valueKey(fv),
              label: label ?? 'null',
              isNull: label === null,
              value: typeof y === 'number' ? y : typeof y === 'bigint' ? Number(y) : null,
              filterValue: fv,
            });
          }
          setData({ key: requestKey, value: { status: 'ready', rows, engineMs: result.engineMs, cached: result.cached } });
        },
        (error: unknown) => {
          performance.clearMarks(start);
          if (!live.current || isAbandoned(error)) return;
          const message = error instanceof Error ? error.message : String(error);
          const path = typeof error === 'object' && error !== null && 'path' in error ? (error as { path?: string }).path : undefined;
          setData({ key: requestKey, value: { status: 'error', message, path } });
        },
      );
    return () => {
      live.current = false;
    };
    // requestKey captures spec, crossFilters, tableId and dataVersion by value.
  }, [engine, chartId, requestKey]);

  if (data?.key === requestKey) return data.value;
  const previous = data?.value.status === 'ready' ? data.value.rows : null;
  return { status: 'loading', previous };
}

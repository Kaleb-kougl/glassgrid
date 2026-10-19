import { memo, type ReactNode } from 'react';
import { formatterFor, type ValueKind } from '../grid/format.js';
import { measureFormatter } from '@glassgrid/core';
import type { AxisKind, ChartColumns, ChartMark } from './types.js';

export interface ViewDataProps {
  /** The chart's result (from `chartColumnsFromArrow`). */
  data: ChartColumns;
  mark: ChartMark;
  /** Accessible name of the table, e.g. "Trips per day data". */
  label: string;
  xLabel: string;
  yLabel: string;
  colorLabel?: string;
  /** Heatmap cell measure (default `count(*)`). */
  countLabel?: string;
  /** Rows rendered at most (default 1,000); the caption says when rows are left out. */
  maxRows?: number;
  formatValue?: (value: number) => string;
  testId?: string;
}

/** Dimension values (x, bins, scatter coordinates) as the grid prints them, via the shared formatter. */
export function formatDimension(value: number, valueKind: ValueKind, axis: AxisKind): string {
  if (Number.isNaN(value)) return 'null';
  if (axis === 'time') return formatterFor(valueKind === 'date' ? 'date' : 'timestamp')(value) ?? 'null';
  return formatterFor(valueKind.startsWith('decimal:') ? 'other' : valueKind)(value) ?? 'null';
}

interface Column {
  readonly header: string;
  readonly numeric: boolean;
  readonly cell: (row: number) => ReactNode;
}

function columnsFor(props: ViewDataProps): Column[] {
  const { data, mark, xLabel, yLabel, colorLabel } = props;
  // Without a formatter from the caller, one mode for the whole column (all integers, or two decimals throughout).
  const measure = props.formatValue ?? measureFormatter({}, mark === 'heatmap' ? (data.count ?? data.y) : data.y);
  const x = (row: number) =>
    data.categories ? (data.categories[row]?.label ?? '') : formatDimension(data.x[row] ?? Number.NaN, data.xValueKind, data.xKind);
  const xEnd = (row: number) => formatDimension(data.xEnd?.[row] ?? Number.NaN, data.xValueKind, data.xKind);
  const yDim = (row: number) => formatDimension(data.y[row] ?? Number.NaN, data.yValueKind, data.yKind);
  const yEnd = (row: number) => formatDimension(data.yEnd?.[row] ?? Number.NaN, data.yValueKind, data.yKind);
  const y = (row: number) => {
    const v = data.y[row] ?? Number.NaN;
    if (Number.isNaN(v)) return '–';
    return data.yKind === 'time' ? yDim(row) : measure(v);
  };
  const color: Column[] =
    data.series && data.seriesList.length > 0
      ? [{ header: colorLabel ?? 'color', numeric: false, cell: (row) => data.seriesList[data.series?.[row] ?? 0]?.label ?? '' }]
      : [];
  switch (mark) {
    case 'histogram':
      return [{ header: xLabel, numeric: false, cell: (row) => `${x(row)} – ${xEnd(row)}` }, ...color, { header: yLabel, numeric: true, cell: y }];
    case 'heatmap':
      return [
        { header: xLabel, numeric: false, cell: (row) => `${x(row)} – ${xEnd(row)}` },
        { header: yLabel, numeric: false, cell: (row) => `${yDim(row)} – ${yEnd(row)}` },
        { header: props.countLabel ?? 'count(*)', numeric: true, cell: (row) => measure(data.count?.[row] ?? Number.NaN) },
      ];
    case 'scatter':
      return [{ header: xLabel, numeric: data.xKind === 'number', cell: x }, { header: yLabel, numeric: data.yKind === 'number', cell: yDim }, ...color];
    default:
      return [{ header: xLabel, numeric: false, cell: x }, ...color, { header: yLabel, numeric: true, cell: y }];
  }
}

/**
 * A chart's aggregate rows as an accessible table ("View data"). Lines and
 * histograms list rows in x order per series; other marks in result order.
 * Memoized: brushing does not re-render it.
 */
export const ViewData = memo(function ViewData(props: ViewDataProps) {
  const { data, mark, label, maxRows = 1000, testId } = props;
  const columns = columnsFor(props);
  const ordered = mark === 'line' || mark === 'area' || mark === 'histogram';
  const shown = Math.min(data.length, maxRows);
  const rows: number[] = [];
  for (let k = 0; k < shown; k += 1) rows.push(ordered ? (data.order[k] ?? k) : k);
  return (
    <table aria-label={label} data-testid={testId}>
      {shown < data.length && (
        <caption className="gg-chart-data__note">
          First {shown.toLocaleString('en-US')} of {data.length.toLocaleString('en-US')} rows
        </caption>
      )}
      <thead>
        <tr>
          {columns.map((column, c) => (
            <th key={c} scope="col" style={column.numeric ? { textAlign: 'right' } : undefined}>
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row}>
            {columns.map((column, c) => (
              <td key={c} className={column.numeric ? 'gg-num' : undefined}>
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
});

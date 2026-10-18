import type { Table } from 'apache-arrow';
import { useMemo } from 'react';
import type { ResolvedTokens } from '../tokens.js';
import { chartColumnsFromArrow } from './arrow.js';
import { seriesColors } from './colors.js';
import type { BrushHandler, ChartColumns, ChartMark, IntervalSelection } from './types.js';

/** Props shared by the brushable marks (line, area, histogram, heatmap, scatter). */
export interface ChartCommonProps {
  /**
   * The chart's aggregate result as Arrow, columns per the compiler contract
   * (docs/m1-compiler.md): `x`, `y` (+ `x_end`, `y_end`, `count`) and, with
   * a colour field, `color` + `color_other`.
   */
  table: Table;
  /** Already-adapted columns of `table` (skips the adapter, e.g. when the caller shares them with "View data"). */
  data?: ChartColumns;
  /** Resolved tokens of the current theme (canvas cannot read CSS variables). */
  tokens: ResolvedTokens;
  /** Accessible name of the chart (usually the card title). */
  label: string;
  /** Field expressions as the shelves show them: `day(pickup_datetime)`, `count(*)`. */
  xLabel: string;
  yLabel: string;
  colorLabel?: string;
  /** Plot height in CSS px (default 160). */
  height?: number;
  /** This chart's own selection (controlled); null or absent for none. */
  selection?: IntervalSelection | null;
  /**
   * Brush callback, data space. `move` fires while dragging (the overlay is
   * already drawn; commit to the store at most once per frame); `end` on
   * release, keyboard change or clear (`null`). Without it the chart does not brush.
   */
  onBrush?: BrushHandler;
  /** Measure text for tooltips and "View data" (default: grouped, up to 6 decimals). */
  formatValue?: (value: number) => string;
  /** Series keys in palette order, to keep colours stable across re-queries. */
  colorKeys?: readonly string[];
  /**
   * Called after the chart's layers are rebuilt and painted for a new result,
   * size or theme (synchronously, in the layout phase): the app's "drawn" mark.
   */
  onDrawn?: () => void;
  testId?: string;
}

export const DEFAULT_CHART_HEIGHT = 160;

/** Rows the hidden screen-reader table lists (the visible "View data" lists up to 1,000). */
export const HIDDEN_TABLE_ROWS = 300;

export function useChartColumns(table: Table, mark: ChartMark, data?: ChartColumns): ChartColumns {
  return useMemo(() => data ?? chartColumnsFromArrow(table, mark), [table, mark, data]);
}

export function useSeriesColors(data: ChartColumns, tokens: ResolvedTokens, colorKeys?: readonly string[]): string[] {
  const keysKey = colorKeys?.join('\u0001') ?? '';
  return useMemo(() => seriesColors(data.seriesList, tokens, colorKeys), [data.seriesList, tokens, keysKey]);
}

const MARK_NAMES: Record<ChartMark, string> = {
  bar: 'Bar chart',
  line: 'Line chart',
  area: 'Area chart',
  histogram: 'Histogram',
  heatmap: 'Heatmap',
  scatter: 'Scatter plot',
};

/** "Trips per day. Line chart of count(*) by day(pickup_datetime), coloured by payment_type, 31 rows." */
export function chartSummary(mark: ChartMark, label: string, xLabel: string, yLabel: string, rows: number, colorLabel?: string): string {
  const what = mark === 'scatter' ? `${yLabel} against ${xLabel}` : mark === 'heatmap' ? `${xLabel} by ${yLabel}` : `${yLabel} by ${xLabel}`;
  const color = colorLabel ? `, coloured by ${colorLabel}` : '';
  return `${label}. ${MARK_NAMES[mark]} of ${what}${color}, ${rows.toLocaleString('en-US')} ${rows === 1 ? 'row' : 'rows'}.`;
}

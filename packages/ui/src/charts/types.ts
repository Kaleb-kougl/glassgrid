import type { FilterValue } from '@glassgrid/core';
import type { ValueKind } from '../grid/format.js';

/** The marks the chart layer draws (`ChartSpec.mark`). */
export type ChartMark = 'bar' | 'line' | 'area' | 'histogram' | 'heatmap' | 'scatter';

/**
 * How an axis reads its values: `number` (DOUBLE, integers, decimals),
 * `time` (DATE/TIMESTAMP as epoch milliseconds, UTC) or `category`
 * (anything else, bar x only; the value is an index into `categories`).
 */
export type AxisKind = 'number' | 'time' | 'category';

/** One colour series (`color` / `color_other` in the result). */
export interface ChartSeries {
  /** Position in the series list (colour order: largest total first, Other last). */
  readonly index: number;
  /** Stable identity: JSON of the filter value, or `OTHER_SERIES_KEY`. */
  readonly key: string;
  /** Display text: the formatted value, `null` for a NULL series, `Other` for the folded rest. */
  readonly label: string;
  /** The value as an `in` filter value (null for the NULL series and for Other). */
  readonly value: FilterValue;
  readonly isOther: boolean;
  readonly isNull: boolean;
  /** Rows of the result in this series. */
  readonly rows: number;
  /** Sum of the finite measures of its rows (rows for scatter), used for ranking. */
  readonly total: number;
}

/** A category of a bar chart's x axis. */
export interface ChartCategory {
  readonly key: string;
  readonly label: string;
  readonly isNull: boolean;
  /** The folded "Other" bar of a top-N bar chart (`x_other` TRUE): key `OTHER_SERIES_KEY`, label `Other`, value null. */
  readonly isOther?: boolean;
  readonly value: FilterValue;
}

/**
 * A chart result as typed columns, one entry per result row (no per-row
 * objects). Time values are epoch milliseconds (UTC), NULL measures are NaN.
 */
export interface ChartColumns {
  readonly length: number;
  /** x (number or epoch ms), or the category index for `xKind: 'category'`. */
  readonly x: Float64Array;
  /** Bin end (`x_end`), histogram and heatmap. */
  readonly xEnd: Float64Array | null;
  /** Measure, or scatter y, or the heatmap's y bin start. NaN for NULL. */
  readonly y: Float64Array;
  /** Heatmap y bin end (`y_end`). */
  readonly yEnd: Float64Array | null;
  /** Heatmap cell count. */
  readonly count: Float64Array | null;
  /** Series index of each row, or null without a colour field. */
  readonly series: Uint8Array | null;
  readonly seriesList: readonly ChartSeries[];
  readonly xKind: AxisKind;
  readonly yKind: AxisKind;
  /** Formatter kinds of the raw columns, for labels and "View data". */
  readonly xValueKind: ValueKind;
  readonly yValueKind: ValueKind;
  readonly colorValueKind: ValueKind;
  /** Bar x categories in result order (`xKind: 'category'`). */
  readonly categories: readonly ChartCategory[] | null;
  /**
   * Row indices grouped by series (series order); for line, area and
   * histogram each group is sorted by x ascending (ties keep result order),
   * other marks keep result order. `seriesStart[s]..seriesStart[s + 1]` is series s.
   */
  readonly order: Uint32Array;
  readonly seriesStart: Uint32Array;
}

/** A brush bound: a number on numeric axes, an ISO timestamp (`YYYY-MM-DD HH:MM:SS[.fff]`, UTC) on time axes. */
export type BrushValue = number | string;

/**
 * An interval selection in data space: `x` for 1-D brushes, `x` and `y` for
 * 2-D brushes. Bounds are ordered (`[lo, hi]`). Snapped to bins (histogram,
 * heatmap) a bound is a bin edge and the interval is half-open: `lo <= v < hi`.
 */
export interface IntervalSelection {
  readonly x: readonly [BrushValue, BrushValue];
  readonly y?: readonly [BrushValue, BrushValue];
}

/** `move` while dragging (overlay only, may fire every frame); `end` once committed. */
export type BrushPhase = 'move' | 'end';

export type BrushHandler = (selection: IntervalSelection | null, phase: BrushPhase) => void;

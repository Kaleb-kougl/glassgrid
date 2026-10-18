import { z } from 'zod';
import { type ChartSpec } from '../spec/chart.js';
import { isNumericType, isTemporalType, type ColumnType } from '../spec/column.js';
import { FilterValueSchema, MAX_FILTER_VALUES, RangeBoundSchema, type Filter, type FilterValue, type RangeBound } from '../spec/filter.js';
import { addTime, binStart, parseTemporal, truncateTime } from '../sql/bins.js';
import { type CubeColumn } from '../sql/cube.js';
import { ColumnNameSchema, type Selection, type SelectionChannel, type SelectionClause } from '../state/workspace.js';
import { resolveAxis, type ResolvedAxis } from './axes.js';

/*
 * Brushes and clicks to selections. A brush is committed once, on pointer
 * release (moves are local UI state), through the `brush` command, which
 * turns the gesture into filters:
 *
 * - a brush on a binned axis (histogram, heatmap, time buckets) snaps
 *   outwards to bin edges and becomes a half-open range [lo, hi), so it
 *   selects exactly the rows drawn in those bins and a cross-filter cube can
 *   answer it exactly (numeric edges are `binStart(k, width)`, which is
 *   `k * width` except where that product rounds across the edge);
 * - a brush on a raw axis (scatter, a line over raw numbers) is an inclusive
 *   range [min, max];
 * - a click on bars becomes an `in` filter (`notIn` of the other named bars
 *   when the "Other" bar is part of it); a click on a time-bucketed bar
 *   becomes its bucket's range;
 * - a 2-D brush (heatmap, scatter) becomes two ranges.
 */

export const BrushRangeSchema = z
  .strictObject({
    /** Lower end in data units: a number, or a date/timestamp as ISO text or epoch ms. Omit for an open end. */
    min: RangeBoundSchema.optional(),
    max: RangeBoundSchema.optional(),
  })
  .refine((range) => range.min !== undefined || range.max !== undefined, { message: 'A brush range needs min, max or both' });
export type BrushRange = z.infer<typeof BrushRangeSchema>;

export const BrushSelectionSchema = z.discriminatedUnion('type', [
  z
    .strictObject({
      /** A rectangle or band dragged over the plot. */
      type: z.literal('interval'),
      x: BrushRangeSchema.optional(),
      /** Heatmap and scatter only. */
      y: BrushRangeSchema.optional(),
      /** The grid only: the column the range is on. */
      column: ColumnNameSchema.optional(),
    })
    .refine((brush) => brush.x !== undefined || brush.y !== undefined, { message: 'An interval needs x, y or both' }),
  z
    .strictObject({
      /** Marks clicked (bars of a bar chart, or values in the grid). */
      type: z.literal('points'),
      values: z.array(FilterValueSchema).max(MAX_FILTER_VALUES),
      /**
       * Include the "Other" bar of a top-N bar chart: `shown` lists the named
       * bars the chart shows, so Other is "every value not shown".
       */
      other: z.strictObject({ shown: z.array(FilterValueSchema).max(MAX_FILTER_VALUES) }).optional(),
      /** The grid only: the column the values are from. */
      column: ColumnNameSchema.optional(),
    })
    .refine((points) => points.values.length > 0 || points.other !== undefined, {
      message: 'Select at least one value, or the "Other" bar',
    }),
]);
export type BrushSelection = z.infer<typeof BrushSelectionSchema>;
export type BrushSelectionInput = z.input<typeof BrushSelectionSchema>;

/** A selection problem, with the input path it concerns. */
export class BrushError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'BrushError';
  }
}

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

/** A temporal value as DuckDB-style text: `2024-03-01` for a date, `2024-03-01 06:30:00[.250]` for a timestamp. */
export function formatTemporal(ms: number, type: ColumnType): string {
  const d = new Date(ms);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (type === 'date' && ms % 86_400_000 === 0) return date;
  const millis = d.getUTCMilliseconds();
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${millis === 0 ? '' : `.${pad(millis, 3)}`}`;
}

function temporalMs(value: RangeBound, path: string, column: CubeColumn): number {
  const ms = parseTemporal(value);
  if (ms === null) {
    throw new BrushError(
      `${path} must be a date or timestamp (ISO text such as "2024-03-01" or epoch milliseconds) because ${JSON.stringify(column.name)} is a ${column.type}; got ${JSON.stringify(value)}`,
      path,
    );
  }
  return ms;
}

function numberValue(value: RangeBound, path: string, column: CubeColumn): number {
  if (typeof value !== 'number') {
    throw new BrushError(`${path} must be a number because ${JSON.stringify(column.name)} is ${column.type}; got ${JSON.stringify(value)}`, path);
  }
  return value;
}

/** Index of the bin holding `value`, exactly as the compiler bins (`floor(CAST(v AS DOUBLE) / width)`). */
export function binIndex(value: number, width: number): number {
  return Math.floor(value / width);
}

function ordered<T extends number>(a: T | undefined, b: T | undefined): [T | undefined, T | undefined] {
  return a !== undefined && b !== undefined && b < a ? [b, a] : [a, b];
}

/** The range filter a brush over `axis` selects: snapped to whole bins on binned axes. */
export function brushRangeFilter(axis: ResolvedAxis, range: BrushRange, path: string): Filter {
  const column = axis.column;
  const name = column.name;
  if (axis.kind === 'width') {
    const [lo, hi] = ordered(
      range.min === undefined ? undefined : numberValue(range.min, `${path}.min`, column),
      range.max === undefined ? undefined : numberValue(range.max, `${path}.max`, column),
    );
    const w = axis.width;
    const kLo = lo === undefined ? undefined : binIndex(lo, w);
    let kHi: number | undefined;
    if (hi !== undefined) {
      const k = binIndex(hi, w);
      // A brush ending exactly where a bin starts does not take that bin.
      kHi = binStart(k, w) === hi ? k : k + 1;
      if (kLo !== undefined && kHi <= kLo) kHi = kLo + 1;
    }
    // Bounds are bin starts, so the range holds exactly the rows the chart draws in those bins.
    return {
      kind: 'range',
      column: name,
      ...(kLo === undefined ? {} : { min: binStart(kLo, w) }),
      ...(kHi === undefined ? {} : { max: binStart(kHi, w) }),
      minInclusive: true,
      maxInclusive: false,
    };
  }
  if (axis.kind === 'time') {
    const [lo, hi] = ordered(
      range.min === undefined ? undefined : temporalMs(range.min, `${path}.min`, column),
      range.max === undefined ? undefined : temporalMs(range.max, `${path}.max`, column),
    );
    const start = lo === undefined ? undefined : truncateTime(lo, axis.unit);
    let end: number | undefined;
    if (hi !== undefined) {
      const bucket = truncateTime(hi, axis.unit);
      end = bucket === hi ? hi : addTime(bucket, axis.unit);
      if (start !== undefined && end <= start) end = addTime(start, axis.unit);
    }
    return {
      kind: 'range',
      column: name,
      ...(start === undefined ? {} : { min: formatTemporal(start, column.type) }),
      ...(end === undefined ? {} : { max: formatTemporal(end, column.type) }),
      minInclusive: true,
      maxInclusive: false,
    };
  }
  // Raw positional axis: an inclusive range in data units.
  if (isTemporalType(column.type)) {
    const [lo, hi] = ordered(
      range.min === undefined ? undefined : temporalMs(range.min, `${path}.min`, column),
      range.max === undefined ? undefined : temporalMs(range.max, `${path}.max`, column),
    );
    return {
      kind: 'range',
      column: name,
      ...(lo === undefined ? {} : { min: formatTemporal(lo, column.type) }),
      ...(hi === undefined ? {} : { max: formatTemporal(hi, column.type) }),
      minInclusive: true,
      maxInclusive: true,
    };
  }
  if (!isNumericType(column.type)) {
    throw new BrushError(`${JSON.stringify(name)} is ${column.type}, so it cannot be brushed as a range; click values instead.`, path);
  }
  const [lo, hi] = ordered(
    range.min === undefined ? undefined : numberValue(range.min, `${path}.min`, column),
    range.max === undefined ? undefined : numberValue(range.max, `${path}.max`, column),
  );
  return {
    kind: 'range',
    column: name,
    ...(lo === undefined ? {} : { min: lo }),
    ...(hi === undefined ? {} : { max: hi }),
    minInclusive: true,
    maxInclusive: true,
  };
}

function uniqueValues(values: readonly FilterValue[]): FilterValue[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = JSON.stringify(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** `in` the clicked values, or with "Other" `notIn` the shown values that were not clicked. */
function pointsFilter(column: string, points: Extract<BrushSelection, { type: 'points' }>): Filter {
  if (points.other === undefined) return { kind: 'in', column, values: uniqueValues(points.values) };
  const clicked = new Set(points.values.map((value) => JSON.stringify(value)));
  return { kind: 'notIn', column, values: uniqueValues(points.other.shown.filter((value) => !clicked.has(JSON.stringify(value)))) };
}

/** The selection a brush or click on a chart makes, or throws `BrushError`. */
export function chartSelection(spec: ChartSpec, brush: BrushSelection, columns: readonly CubeColumn[]): Selection {
  if (brush.column !== undefined && brush.column !== spec.x.column && brush.column !== spec.y?.column) {
    throw new BrushError(`column ${JSON.stringify(brush.column)} is not on this chart; omit column for charts`, 'selection.column');
  }
  if (brush.type === 'points') {
    if (spec.mark !== 'bar') {
      throw new BrushError(`Only bar charts select values by clicking; brush a range on this ${spec.mark} chart instead.`, 'selection.type');
    }
    const axis = resolveAxis(spec, 'x', columns);
    if (axis?.kind === 'time') {
      if (brush.other !== undefined || brush.values.length !== 1) {
        throw new BrushError(
          `x is bucketed by ${axis.unit}: select one bucket by clicking, or brush a range of buckets with type "interval".`,
          'selection.values',
        );
      }
      const [value] = brush.values;
      if (value === null || value === undefined || typeof value === 'boolean') {
        throw new BrushError('A time bucket is selected by its start date or timestamp.', 'selection.values[0]');
      }
      return { source: 'click', clauses: [{ channel: 'x', filter: brushRangeFilter(axis, { min: value, max: value }, 'selection.values[0]') }] };
    }
    return { source: 'click', clauses: [{ channel: 'x', filter: pointsFilter(spec.x.column, brush) }] };
  }
  const clauses: SelectionClause[] = [];
  for (const channel of ['x', 'y'] as const satisfies readonly SelectionChannel[]) {
    const range = brush[channel];
    if (range === undefined) continue;
    const axis = resolveAxis(spec, channel, columns);
    if (axis === null) {
      throw new BrushError(
        channel === 'y'
          ? `Only heatmap and scatter charts brush along y; this is a ${spec.mark} chart.`
          : `x of this ${spec.mark} chart is not a positional axis; click bars to select values.`,
        `selection.${channel}`,
      );
    }
    if (axis.kind === 'raw' && spec.mark === 'bar') {
      throw new BrushError('Bar charts select values: use { type: "points", values } (brush ranges only on time buckets).', 'selection.type');
    }
    clauses.push({ channel, filter: brushRangeFilter(axis, range, `selection.${channel}`) });
  }
  return { source: 'brush', clauses };
}

/** The selection a range or click in the grid makes on one column. */
export function gridSelection(brush: BrushSelection, columns: readonly CubeColumn[]): Selection {
  if (brush.column === undefined) throw new BrushError('The grid selects on one column: set selection.column.', 'selection.column');
  const column = columns.find((candidate) => candidate.name === brush.column);
  if (!column) throw new BrushError(`Unknown column ${JSON.stringify(brush.column)}`, 'selection.column');
  if (brush.type === 'points') return { source: 'click', clauses: [{ channel: null, filter: pointsFilter(column.name, brush) }] };
  if (brush.y !== undefined) throw new BrushError('The grid selects a range on one column: use x only.', 'selection.y');
  const range = brush.x;
  if (range === undefined) throw new BrushError('An interval in the grid needs x.', 'selection.x');
  return { source: 'brush', clauses: [{ channel: null, filter: brushRangeFilter({ kind: 'raw', column }, range, 'selection.x') }] };
}

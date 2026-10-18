import { type ChartSpec, type Mark } from '../spec/chart.js';
import { isNumericType, isTemporalType } from '../spec/column.js';
import { type Field, type YField } from '../spec/field.js';
import { type CubeColumn } from '../sql/cube.js';

/*
 * Default charts (docs/technical-design.md, "Default chart rules (v1)") and
 * re-deriving shelves when a chart switches marks. Pure: the commands
 * validate the result against the compiler.
 */

/** Categories with at most this many distinct values get one bar each. */
export const CATEGORY_ALL_BARS_MAX = 50;
/** Above that, the default bar chart shows this many bars plus "Other". */
export const CATEGORY_TOP_BARS = 20;

type Kind = 'temporal' | 'number' | 'category';

function kindOf(column: CubeColumn): Kind {
  if (isTemporalType(column.type)) return 'temporal';
  if (isNumericType(column.type)) return 'number';
  return 'category';
}

/** Bars for a category: all of them up to 50 distinct values, else the top 20 plus "Other". Unknown counts get top 20 + Other. */
function categoryBar(column: CubeColumn, y?: YField, color?: Field): ChartSpec {
  const few = column.distinctCount !== undefined && column.distinctCount <= CATEGORY_ALL_BARS_MAX;
  return {
    mark: 'bar',
    x: { column: column.name },
    ...(y ? { y } : {}),
    ...(color ? { color } : {}),
    filters: [],
    ...(few ? { limit: CATEGORY_ALL_BARS_MAX } : { limit: CATEGORY_TOP_BARS, other: true }),
  };
}

/**
 * The default chart for one column, or for two dropped together.
 *
 * | Columns | Chart |
 * | --- | --- |
 * | date/timestamp | line of row counts, automatic time bucket (hour / day / month) |
 * | category, ≤ 50 distinct | bar of row counts, sorted descending, every value |
 * | category, > 50 distinct (or unknown) | bar of the top 20 + "Other" |
 * | number | histogram, automatic bin width |
 * | number + number (or dates) | binned scatter: heatmap of row counts |
 * | date + number | line of sum(number) |
 * | date + category | line of row counts, one series per category |
 * | category + number | bar of sum(number) |
 * | category + category | bar split by colour |
 * | number + category | histogram split by colour |
 *
 * Booleans count as categories.
 */
export function defaultChartSpec(first: CubeColumn, second?: CubeColumn): ChartSpec {
  const a = kindOf(first);
  if (!second) {
    switch (a) {
      case 'temporal':
        return { mark: 'line', x: { column: first.name }, filters: [] };
      case 'number':
        return { mark: 'histogram', x: { column: first.name, bin: 'auto' }, filters: [] };
      case 'category':
        return categoryBar(first);
    }
  }
  const b = kindOf(second);
  const sum: YField = { column: second.name, aggregate: 'sum' };
  const color: Field = { column: second.name };
  if (a === b && a !== 'category') {
    return { mark: 'heatmap', x: { column: first.name, bin: 'auto' }, y: { column: second.name, bin: 'auto' }, filters: [] };
  }
  if (a === 'temporal' && b === 'number') return { mark: 'line', x: { column: first.name }, y: sum, filters: [] };
  if (a === 'number' && b === 'temporal') return { mark: 'line', x: { column: second.name }, y: { column: first.name, aggregate: 'sum' }, filters: [] };
  if (a === 'temporal') return { mark: 'line', x: { column: first.name }, color, filters: [] };
  if (b === 'temporal') return { mark: 'line', x: { column: second.name }, color: { column: first.name }, filters: [] };
  if (a === 'category' && b === 'number') return categoryBar(first, sum);
  if (a === 'category') return categoryBar(first, undefined, color);
  return { mark: 'histogram', x: { column: first.name, bin: 'auto' }, color, filters: [] };
}

function positional(column: CubeColumn | undefined): boolean {
  return column !== undefined && (isNumericType(column.type) || isTemporalType(column.type));
}

/** Drop a field's binning and time unit (for channels that take raw values). */
function raw(field: Field): Field {
  return { column: field.column };
}

/**
 * The spec after switching to `mark`, keeping what still makes sense: x
 * stays, y keeps its aggregate on marks that aggregate and becomes the second
 * axis on heatmap and scatter (and back), bins and time units are kept where
 * the mark takes them, colour is dropped on heatmaps, `limit`/`other` only
 * stay on bars. Throws `MarkError` when the columns cannot make that mark.
 */
export function specForMark(spec: ChartSpec, mark: Mark, columns: readonly CubeColumn[]): ChartSpec {
  const find = (name: string | undefined) => (name === undefined ? undefined : columns.find((column) => column.name === name));
  const x = find(spec.x.column);
  const yColumn = find(spec.y?.column);
  const temporalX = x !== undefined && isTemporalType(x.type);
  const twoAxes = spec.mark === 'heatmap' || spec.mark === 'scatter';
  const measure: YField | undefined = twoAxes ? undefined : spec.y;
  const filters = spec.filters;
  switch (mark) {
    case 'bar': {
      const field: Field = temporalX && spec.x.timeUnit !== undefined ? { column: spec.x.column, timeUnit: spec.x.timeUnit } : { column: spec.x.column };
      const limit = spec.mark === 'bar' ? spec.limit : undefined;
      return {
        mark,
        x: field,
        ...(measure ? { y: measure } : {}),
        ...(spec.color ? { color: raw(spec.color) } : {}),
        filters,
        ...(limit === undefined ? {} : { limit }),
        ...(spec.mark === 'bar' && spec.other !== undefined ? { other: spec.other } : {}),
      };
    }
    case 'histogram':
    case 'line':
    case 'area': {
      if (!positional(x)) {
        throw new MarkError(`${mark} charts need a numeric, date or timestamp column on x, but ${JSON.stringify(spec.x.column)} is ${x?.type ?? 'unknown'}. Use mark "bar" for categories.`, 'mark');
      }
      let field: Field = { column: spec.x.column };
      if (temporalX && spec.x.timeUnit !== undefined) field = { ...field, timeUnit: spec.x.timeUnit };
      if (!temporalX && spec.x.bin !== undefined) field = { ...field, bin: spec.x.bin };
      if (!temporalX && mark === 'histogram' && field.bin === undefined) field = { ...field, bin: 'auto' };
      return {
        mark,
        x: field,
        ...(measure ? { y: measure } : {}),
        ...(spec.color ? { color: raw(spec.color) } : {}),
        filters,
      };
    }
    case 'heatmap':
    case 'scatter': {
      const second = spec.y?.column;
      if (!positional(x) || second === undefined || !positional(yColumn)) {
        throw new MarkError(
          `${mark} charts need numeric, date or timestamp columns on both x and y${second === undefined ? '; put a second column on y first' : `, but ${JSON.stringify(!positional(x) ? spec.x.column : second)} is ${(!positional(x) ? x : yColumn)?.type ?? 'unknown'}`}.`,
          second === undefined ? 'y' : 'mark',
        );
      }
      if (mark === 'heatmap') {
        const axis = (field: Field, column: CubeColumn | undefined): Field =>
          column !== undefined && isTemporalType(column.type)
            ? { column: field.column, ...(field.timeUnit === undefined ? {} : { timeUnit: field.timeUnit }) }
            : { column: field.column, bin: typeof field.bin === 'number' ? field.bin : 'auto' };
        return { mark, x: axis(spec.x, x), y: { ...axis({ column: second }, yColumn) }, filters };
      }
      return {
        mark,
        x: raw(spec.x),
        y: { column: second },
        ...(spec.color ? { color: raw(spec.color) } : {}),
        filters,
      };
    }
  }
}

export class MarkError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'MarkError';
  }
}

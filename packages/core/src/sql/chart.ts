import { isNumericType, isTemporalType, type CompileColumn } from '../spec/column.js';
import {
  ChartSpecSchema,
  DEFAULT_BAR_LIMIT,
  MAX_BAR_LIMIT,
  MAX_COLOR_SERIES,
  SCATTER_MAX_POINTS,
  type ChartSpec,
  type ChartSpecInput,
  type Mark,
} from '../spec/chart.js';
import { type CrossfilterDimension } from '../spec/crossfilter.js';
import { type Aggregate, type Field, type TimeUnit, type YField } from '../spec/field.js';
import { type Filter } from '../spec/filter.js';
import { autoTimeUnit, niceBinWidth, numericBinCount, type TimeUnitStrategy } from './bins.js';
import { cubeSelection } from './align.js';
import { compareText, Params, quoteIdent, ROW_COUNT_COLUMN, type CompiledQuery } from './builder.js';
import { ColumnIndex } from './columns.js';
import { CompileError, type CompileErrorCode } from './errors.js';
import { compileFilter, filterPredicates, parseOrThrow, whereClause } from './where.js';

/** Target bin count for `bin: 'auto'` (or no bin) on a histogram. */
export const HISTOGRAM_TARGET_BINS = 50;
/** Target bins per axis for an automatic heatmap axis. */
export const HEATMAP_TARGET_BINS = 100;
/** An explicit histogram bin width may not produce more bins than this. */
export const MAX_HISTOGRAM_BINS = 10_000;
/** An explicit heatmap bin width may not produce more bins per axis than this. */
export const MAX_HEATMAP_BINS_PER_AXIS = 1_000;
/** Line/area auto time unit: the finest unit with at most this many buckets. */
export const LINE_AUTO_MAX_BUCKETS = 20_000;
/** M4 pixel columns when `opts.pixelWidth` is not given. */
export const DEFAULT_PIXEL_WIDTH = 1_000;
export const MAX_PIXEL_WIDTH = 16_384;

export interface ChartCompileOptions {
  /**
   * Plot width in device pixels; line and area charts keep at most four
   * points (first, last, min, max) per pixel column per series. Integer in
   * [1, 16384]; defaults to 1000.
   */
  readonly pixelWidth?: number;
}

const UNIT_SQL: Record<TimeUnit, string> = { hour: 'HOUR', day: 'DAY', month: 'MONTH' };

/* --------------------------------------------------------------------------
 * Channel resolution
 * ------------------------------------------------------------------------ */

/** How an x/y dimension becomes a group key. */
type Axis =
  | { readonly kind: 'raw'; readonly column: CompileColumn }
  | { readonly kind: 'time'; readonly column: CompileColumn; readonly unit: TimeUnit }
  | { readonly kind: 'bin'; readonly column: CompileColumn; readonly width: string };

/** Expression computed from the table row (the group key). */
function axisKey(axis: Axis): string {
  const ref = quoteIdent(axis.column.name);
  switch (axis.kind) {
    case 'raw':
      return ref;
    case 'time':
      return `date_trunc('${axis.unit}', ${ref})`;
    case 'bin':
      return `floor(CAST(${ref} AS DOUBLE) / ${axis.width})`;
  }
}

/** Start of the group, given the group key expression. */
function axisStart(axis: Axis, key: string): string {
  return axis.kind === 'bin' ? `${key} * ${axis.width}` : key;
}

/** Exclusive end of the group, given the group key expression. */
function axisEnd(axis: Axis, key: string): string {
  switch (axis.kind) {
    case 'raw':
      return key;
    case 'time':
      return `${key} + INTERVAL 1 ${UNIT_SQL[axis.unit]}`;
    case 'bin':
      return `(${key} + 1) * ${axis.width}`;
  }
}

/**
 * Pre-aggregation ("cube") modes of the chart compiler; see sql/cube.ts.
 *
 * - `build`: instead of the chart query, emit one GROUP BY over the table
 *   (the spec's filters applied) by the chart's group keys plus `gb`, the
 *   bin of the cross-filter dimension, with decomposable partial
 *   aggregates (`n` rows, `nn` non-NULL y, `s` sum, `mn` min, `mx` max).
 * - `answer`: emit the chart query over such a cube relation: `__gg_base`
 *   re-sums the partials of the cells whose `gb` the selection covers, and
 *   every mark's SQL then aggregates partials instead of rows.
 */
export type CubeMode =
  | { readonly phase: 'build'; readonly dimension: CrossfilterDimension }
  | { readonly phase: 'answer'; readonly dimension: CrossfilterDimension; readonly selection: Filter | null };

/** A measure: how rows (or cube cells) aggregate into y. */
interface Measure {
  /** Table mode: the `"col" AS gy` projection; null for count(*). */
  readonly select: string | null;
  readonly column: CompileColumn | null;
  /** null means count(*). */
  readonly aggregate: Aggregate | null;
  /** The aggregate over rows of the relation aliased `alias` (`''` or `'s.'`). */
  agg(alias: string): string;
}

/** Cube partial columns: build expression over the y column, and how the answer re-aggregates them. */
const PARTIALS = {
  nn: { build: (ref: string) => `count(${ref})`, merge: 'sum' },
  s: { build: (ref: string) => `sum(${ref})`, merge: 'sum' },
  mn: { build: (ref: string) => `min(${ref})`, merge: 'min' },
  mx: { build: (ref: string) => `max(${ref})`, merge: 'max' },
} as const;
type Partial = keyof typeof PARTIALS;

function partialsFor(aggregate: Aggregate | null): Partial[] {
  switch (aggregate) {
    case null:
      return [];
    case 'count':
      return ['nn'];
    case 'sum':
    case 'avg':
      return ['nn', 's'];
    case 'min':
      return ['mn'];
    case 'max':
      return ['mx'];
  }
}

export class ChartCompiler {
  readonly params = new Params();
  readonly index: ColumnIndex;
  /** Set by `baseCtes` in build mode: the cube's GROUP BY and its parameters. */
  cubeBuild: { sql: string; params: unknown[] } | null = null;

  constructor(
    readonly table: string,
    readonly spec: ChartSpec,
    columns: readonly CompileColumn[],
    readonly cube: CubeMode | null = null,
  ) {
    this.index = new ColumnIndex(columns);
  }

  get mark(): Mark {
    return this.spec.mark;
  }

  fail(code: CompileErrorCode, message: string, path: string): never {
    throw new CompileError(code, message, path);
  }

  column(field: Field, path: string): CompileColumn {
    return this.index.get(field.column, `${path}.column`);
  }

  /** Reject `bin` / `timeUnit` on a channel that takes raw values. */
  noBinning(field: Field, path: string, why: string): void {
    if (field.bin !== undefined) this.fail('unsupported', `${path}.bin is not supported here: ${why}`, `${path}.bin`);
    if (field.timeUnit !== undefined) {
      this.fail('unsupported', `${path}.timeUnit is not supported here: ${why}`, `${path}.timeUnit`);
    }
  }

  requirePositional(column: CompileColumn, path: string): void {
    if (!isNumericType(column.type) && !isTemporalType(column.type)) {
      this.fail(
        'type_mismatch',
        `${this.mark} charts need a numeric, date or timestamp column for ${path}, but ${JSON.stringify(column.name)} is ${column.type}.` +
          (path === 'x' ? ' Use mark "bar" for categories.' : ''),
        `${path}.column`,
      );
    }
  }

  timeAxis(field: Field, column: CompileColumn, path: string, strategy: TimeUnitStrategy): Axis {
    if (typeof field.bin === 'number') {
      this.fail(
        'unsupported',
        `${path}.bin must be "auto" or omitted for the ${column.type} column ${JSON.stringify(column.name)}; set ${path}.timeUnit to "hour", "day" or "month" instead.`,
        `${path}.bin`,
      );
    }
    if (field.timeUnit === 'hour' && column.type === 'date') {
      this.fail(
        'type_mismatch',
        `${path}.timeUnit "hour" needs a timestamp column, but ${JSON.stringify(column.name)} is a date. Use "day" or "month".`,
        `${path}.timeUnit`,
      );
    }
    return { kind: 'time', column, unit: field.timeUnit ?? autoTimeUnit(column.min, column.max, column.type, strategy) };
  }

  noTimeUnitOnNumber(field: Field, column: CompileColumn, path: string): void {
    if (field.timeUnit !== undefined) {
      this.fail(
        'type_mismatch',
        `${path}.timeUnit needs a date or timestamp column, but ${JSON.stringify(column.name)} is ${column.type}.`,
        `${path}.timeUnit`,
      );
    }
  }

  binAxis(column: CompileColumn, width: number): Axis {
    return { kind: 'bin', column, width: this.params.double(width) };
  }

  /** A binned axis for histogram and heatmap: numeric bins or a time unit. */
  binnedAxis(field: Field, path: string, target: number, maxBins: number): Axis {
    const column = this.column(field, path);
    this.requirePositional(column, path);
    if (isTemporalType(column.type)) return this.timeAxis(field, column, path, { mode: 'closest', target });
    this.noTimeUnitOnNumber(field, column, path);
    const min = typeof column.min === 'number' ? column.min : null;
    const max = typeof column.max === 'number' ? column.max : null;
    const bin = field.bin ?? 'auto';
    if (bin === 'auto') {
      return this.binAxis(column, min === null || max === null ? 1 : niceBinWidth(min, max, target, column.type === 'integer'));
    }
    if (min !== null && max !== null) {
      const count = numericBinCount(min, max, bin);
      if (count > maxBins) {
        this.fail(
          'too_many_bins',
          `${path}.bin width ${bin} would split ${JSON.stringify(column.name)} (${min} to ${max}) into ${count} bins; the limit is ${maxBins}. Use a larger width or "auto".`,
          `${path}.bin`,
        );
      }
    }
    return this.binAxis(column, bin);
  }

  /** The measure (y aggregate) for bar, histogram, line and area. */
  measure(): Measure {
    const y = this.spec.y;
    if (!y) return this.makeMeasure(null, null);
    this.noBinning(y, 'y', `${this.mark} charts aggregate y per x value`);
    const column = this.column(y, 'y');
    const aggregate = y.aggregate;
    if (aggregate === undefined) {
      this.fail(
        'invalid_spec',
        `y.aggregate is required for ${this.mark} charts: one of "count", "sum", "avg", "min" or "max".`,
        'y.aggregate',
      );
    }
    switch (aggregate) {
      case 'count':
        break;
      case 'sum':
      case 'avg':
        if (!isNumericType(column.type)) {
          this.fail(
            'type_mismatch',
            `y.aggregate "${aggregate}" needs a numeric column, but ${JSON.stringify(column.name)} is ${column.type}. Use "count"${isTemporalType(column.type) ? ', "min" or "max"' : ''} instead.`,
            'y.aggregate',
          );
        }
        break;
      case 'min':
      case 'max':
        if (!isNumericType(column.type) && !isTemporalType(column.type)) {
          this.fail(
            'type_mismatch',
            `y.aggregate "${aggregate}" needs a numeric, date or timestamp column, but ${JSON.stringify(column.name)} is ${column.type}. Use "count" instead.`,
            'y.aggregate',
          );
        }
        break;
    }
    return this.makeMeasure(column, aggregate);
  }

  private makeMeasure(column: CompileColumn | null, aggregate: Aggregate | null): Measure {
    const select = column ? `${quoteIdent(column.name)} AS gy` : null;
    const temporal = column !== null && isTemporalType(column.type);
    const answer = this.cube?.phase === 'answer';
    const agg = (alias: string): string => {
      if (answer) {
        switch (aggregate) {
          case null:
            return `CAST(sum(${alias}n) AS DOUBLE)`;
          case 'count':
            return `CAST(sum(${alias}nn) AS DOUBLE)`;
          case 'sum':
            return `CAST(sum(${alias}s) AS DOUBLE)`;
          case 'avg':
            return `CAST(sum(${alias}s) AS DOUBLE) / CAST(sum(${alias}nn) AS DOUBLE)`;
          case 'min':
          case 'max': {
            const merged = `${aggregate}(${alias}${aggregate === 'min' ? 'mn' : 'mx'})`;
            return temporal ? merged : `CAST(${merged} AS DOUBLE)`;
          }
        }
      }
      if (aggregate === null) return 'CAST(count(*) AS DOUBLE)';
      const ref = `${alias}gy`;
      if (temporal && (aggregate === 'min' || aggregate === 'max')) return `${aggregate}(${ref})`;
      return `CAST(${aggregate}(${ref}) AS DOUBLE)`;
    };
    return { select, column, aggregate, agg };
  }

  /** Row count of a group (heatmap cells, scatter series ranking). */
  countAgg(alias: string): string {
    return this.cube?.phase === 'answer' ? `CAST(sum(${alias}n) AS DOUBLE)` : 'CAST(count(*) AS DOUBLE)';
  }

  colorColumn(): CompileColumn | null {
    const color = this.spec.color;
    if (!color) return null;
    if (this.mark === 'heatmap') {
      this.fail('unsupported', 'heatmap charts do not take color: cell colour encodes the row count.', 'color');
    }
    this.noBinning(color, 'color', 'color splits rows by distinct values');
    return this.column(color, 'color');
  }

  limit(): number | null {
    const limit = this.spec.limit;
    if (this.spec.other !== undefined && this.mark !== 'bar') {
      this.fail('unsupported', `other applies only to bar charts (top N plus an "Other" bar), not ${this.mark}.`, 'other');
    }
    if (this.mark === 'bar') {
      if (limit !== undefined && limit > MAX_BAR_LIMIT) {
        this.fail('unsupported', `limit for bar charts must be at most ${MAX_BAR_LIMIT}; got ${limit}.`, 'limit');
      }
      return limit ?? DEFAULT_BAR_LIMIT;
    }
    if (this.mark === 'scatter') return limit ?? SCATTER_MAX_POINTS;
    if (limit !== undefined) {
      this.fail('unsupported', `limit applies only to bar (top N) and scatter (point cap) charts, not ${this.mark}.`, 'limit');
    }
    return null;
  }

  /**
   * CTEs shared by every mark: `__gg_base` (filtered rows, only the columns
   * the chart needs, renamed gx/gy/gc) and, with a colour channel,
   * `__gg_series` (top 8 series) and `__gg_src` (base rows with gc folded to
   * NULL + other = TRUE outside the top 8). Returns the relation to aggregate.
   *
   * `keys` are the group keys as `[expression, alias]`; `measure` adds `gy`
   * (table mode) or the cube partials. In cube build mode this records the
   * cube's GROUP BY in `cubeBuild` instead; in answer mode `__gg_base` reads
   * the cube.
   */
  baseCtes(
    keys: readonly (readonly [string, string])[],
    measure: Measure | null,
    notNull: readonly CompileColumn[],
    color: CompileColumn | null,
    rankAgg: (alias: string) => string,
  ): { ctes: string[]; src: string } {
    const keyAliases = [...keys.map(([, alias]) => alias), ...(color ? ['gc'] : [])];
    const partials = measure ? partialsFor(measure.aggregate) : [];
    let base: string;
    if (this.cube === null) {
      const predicates = filterPredicates(this.spec.filters, this.index, this.params);
      for (const column of notNull) predicates.push(`${quoteIdent(column.name)} IS NOT NULL`);
      const selects = [
        ...keys.map(([expr, alias]) => `${expr} AS ${alias}`),
        ...(measure?.select ? [measure.select] : []),
        ...(color ? [`${quoteIdent(color.name)} AS gc`] : []),
      ];
      base = `__gg_base AS (\n  SELECT ${selects.join(', ')}\n  FROM ${this.table}${whereClause(predicates).replaceAll('\n', '\n  ')}\n)`;
    } else if (this.cube.phase === 'build') {
      // Filter order does not change the rows; sorting makes equal filter sets build the same cube.
      const filters = [...this.spec.filters].sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
      const predicates = filterPredicates(filters, this.index, this.params);
      for (const column of notNull) predicates.push(`${quoteIdent(column.name)} IS NOT NULL`);
      const ref = measure?.column ? quoteIdent(measure.column.name) : null;
      const selects = [
        ...keys.map(([expr, alias]) => `${expr} AS ${alias}`),
        ...(color ? [`${quoteIdent(color.name)} AS gc`] : []),
        `${this.dimensionKey(this.cube.dimension)} AS gb`,
        'count(*) AS n',
        ...(ref ? partials.map((partial) => `${PARTIALS[partial].build(ref)} AS ${partial}`) : []),
      ];
      this.cubeBuild = {
        sql: `SELECT ${selects.join(', ')}\nFROM ${this.table}${whereClause(predicates)}\nGROUP BY ALL`,
        params: [...this.params.values],
      };
      return { ctes: [], src: '__gg_base' };
    } else {
      const predicate = this.selectionPredicate(this.cube.dimension, this.cube.selection);
      const merged = ['sum(n) AS n', ...partials.map((partial) => `${PARTIALS[partial].merge}(${partial}) AS ${partial}`)];
      base =
        `__gg_base AS (\n  SELECT ${[...keyAliases, ...merged].join(', ')}\n  FROM ${this.table}` +
        `${predicate === null ? '' : `\n  WHERE ${predicate}`}\n  GROUP BY ${keyAliases.join(', ')}\n)`;
    }
    const ctes = [base];
    if (!color) return { ctes, src: '__gg_base' };
    ctes.push(
      `__gg_series AS (\n  SELECT gc, ${rankAgg('')} AS v, TRUE AS k FROM __gg_base GROUP BY gc\n  ORDER BY v DESC NULLS LAST, gc ASC NULLS LAST LIMIT ${MAX_COLOR_SERIES}\n)`,
      `__gg_src AS (\n  SELECT b.* EXCLUDE (gc), CASE WHEN s.k THEN b.gc END AS gc, s.k IS NULL AS other\n  FROM __gg_base AS b LEFT JOIN __gg_series AS s ON b.gc IS NOT DISTINCT FROM s.gc\n)`,
    );
    return { ctes, src: '__gg_src' };
  }

  /** The cube's `gb` expression: the bin of the dimension column, matching how its selections are written. */
  dimensionKey(dimension: CrossfilterDimension): string {
    const column = this.index.get(dimension.column, 'dimension.column');
    const ref = quoteIdent(column.name);
    switch (dimension.bin.kind) {
      case 'value':
        return ref;
      case 'time':
        if (!isTemporalType(column.type)) {
          this.fail('type_mismatch', `A time-bucketed dimension needs a date or timestamp column; ${JSON.stringify(column.name)} is ${column.type}.`, 'dimension');
        }
        if (dimension.bin.unit === 'hour' && column.type === 'date') {
          this.fail('type_mismatch', `An hourly dimension needs a timestamp column; ${JSON.stringify(column.name)} is a date.`, 'dimension');
        }
        return `date_trunc('${dimension.bin.unit}', ${ref})`;
      case 'width': {
        if (!isNumericType(column.type)) {
          this.fail('type_mismatch', `A binned dimension needs a numeric column; ${JSON.stringify(column.name)} is ${column.type}.`, 'dimension');
        }
        // floor(v / w) can land one bin off at an edge; correct it so that bin k holds exactly
        // k*w <= v < (k+1)*w with the products DuckDB computes, which is how brush filters compare.
        const w = this.params.double(dimension.bin.width);
        const v = `CAST(${ref} AS DOUBLE)`;
        const f = `floor(${v} / ${w})`;
        return `(${f} + CASE WHEN ${v} >= (${f} + 1) * ${w} THEN 1 WHEN ${v} < ${f} * ${w} THEN -1 ELSE 0 END)`;
      }
    }
  }

  /** WHERE predicate on `gb` that selects exactly the rows `selection` selects; null selects all. */
  selectionPredicate(dimension: CrossfilterDimension, selection: Filter | null): string | null {
    if (selection === null) return null;
    const column = this.index.get(dimension.column, 'dimension.column');
    const how = cubeSelection(selection, dimension);
    if (how === null) {
      this.fail('unsupported', 'The selection is not aligned to the cube dimension\'s bins; run the query on the table instead.', 'selection');
    }
    if (how.kind === 'bins') {
      const parts: string[] = [];
      if (how.min !== null) parts.push(`gb >= ${this.params.double(how.min)}`);
      if (how.max !== null) parts.push(`gb < ${this.params.double(how.max)}`);
      return parts.length === 0 ? null : parts.join(' AND ');
    }
    // Value and time dimensions: gb holds the value (or its bucket start), so the filter applies to it as is.
    const gb = new ColumnIndex([{ name: 'gb', type: dimension.bin.kind === 'width' ? 'float' : column.type }]);
    return compileFilter({ ...selection, column: 'gb' }, gb, this.params, 'selection');
  }

  /* ------------------------------------------------------------------------ */

  compile(opts: ChartCompileOptions): string {
    switch (this.mark) {
      case 'bar':
        return this.bar();
      case 'histogram':
        return this.histogram();
      case 'line':
      case 'area':
        return this.line(opts);
      case 'heatmap':
        return this.heatmap();
      case 'scatter':
        return this.scatter();
    }
  }

  bar(): string {
    const { x } = this.spec;
    const column = this.column(x, 'x');
    if (x.bin !== undefined) {
      this.fail(
        'unsupported',
        'bar charts group by distinct x values, so x.bin is not supported. Use mark "histogram" to bin a numeric column.',
        'x.bin',
      );
    }
    let axis: Axis = { kind: 'raw', column };
    if (x.timeUnit !== undefined) {
      if (!isTemporalType(column.type)) this.noTimeUnitOnNumber(x, column, 'x');
      axis = this.timeAxis(x, column, 'x', { mode: 'finest', max: LINE_AUTO_MAX_BUCKETS });
    }
    const measure = this.measure();
    const color = this.colorColumn();
    const limitValue = this.limit() ?? DEFAULT_BAR_LIMIT;
    const { ctes, src } = this.baseCtes([[axisKey(axis), 'gx']], measure, [], color, (a) => measure.agg(a));
    const limit = this.params.bigint(limitValue);
    const other = this.spec.other === true;
    if (!color && !other) {
      return (
        `WITH ${ctes.join(',\n')}\n` +
        `SELECT gx AS x, ${measure.agg('')} AS y\nFROM ${src}\nGROUP BY gx\n` +
        `ORDER BY y DESC NULLS LAST, gx ASC NULLS LAST\nLIMIT ${limit}`
      );
    }
    ctes.push(
      `__gg_top AS (\n  SELECT gx, ${measure.agg('')} AS v${other ? ', TRUE AS k' : ''} FROM __gg_base GROUP BY gx\n  ORDER BY v DESC NULLS LAST, gx ASC NULLS LAST LIMIT ${limit}\n)`,
    );
    if (!other) {
      return (
        `WITH ${ctes.join(',\n')}\n` +
        `SELECT s.gx AS x, s.gc AS color, s.other AS color_other, ${measure.agg('s.')} AS y\n` +
        `FROM ${src} AS s JOIN __gg_top AS t ON s.gx IS NOT DISTINCT FROM t.gx\n` +
        `GROUP BY s.gx, s.gc, s.other, t.v\n` +
        `ORDER BY t.v DESC NULLS LAST, s.gx ASC NULLS LAST, s.other ASC, s.gc ASC NULLS LAST`
      );
    }
    // x values outside the top N fold into one "Other" bar (x NULL, x_other TRUE), measured over its own rows.
    const colorSelect = color ? ', s.gc AS color, s.other AS color_other' : '';
    const colorOrder = color ? ', color_other ASC, color ASC NULLS LAST' : '';
    return (
      `WITH ${ctes.join(',\n')}\n` +
      `SELECT x, x_other${color ? ', color, color_other' : ''}, y FROM (\n` +
      `  SELECT CASE WHEN t.k THEN s.gx END AS x, t.k IS NULL AS x_other${colorSelect}, t.v AS v, ${measure.agg('s.')} AS y\n` +
      `  FROM ${src} AS s LEFT JOIN __gg_top AS t ON s.gx IS NOT DISTINCT FROM t.gx\n` +
      `  GROUP BY ALL\n` +
      `)\nORDER BY x_other ASC, v DESC NULLS LAST, x ASC NULLS LAST${colorOrder}`
    );
  }

  histogram(): string {
    const axis = this.binnedAxis(this.spec.x, 'x', HISTOGRAM_TARGET_BINS, MAX_HISTOGRAM_BINS);
    const measure = this.measure();
    const color = this.colorColumn();
    this.limit();
    const { ctes, src } = this.baseCtes([[axisKey(axis), 'gx']], measure, [axis.column], color, (a) => measure.agg(a));
    const colorSelect = color ? ', gc AS color, other AS color_other' : '';
    return (
      `WITH ${ctes.join(',\n')}\n` +
      `SELECT ${axisStart(axis, 'gx')} AS x, ${axisEnd(axis, 'gx')} AS x_end${colorSelect}, ${measure.agg('')} AS y\n` +
      `FROM ${src}\nGROUP BY gx${color ? ', gc, other' : ''}\n` +
      `ORDER BY gx${color ? ', other ASC, gc ASC NULLS LAST' : ''}`
    );
  }

  heatmap(): string {
    const y = this.spec.y;
    if (!y) this.fail('invalid_spec', 'heatmap charts need y: the column for the vertical axis.', 'y');
    if (y.aggregate !== undefined && y.aggregate !== 'count') {
      this.fail(
        'unsupported',
        `heatmap cells always count rows, so y.aggregate must be omitted or "count"; got "${y.aggregate}".`,
        'y.aggregate',
      );
    }
    const xAxis = this.binnedAxis(this.spec.x, 'x', HEATMAP_TARGET_BINS, MAX_HEATMAP_BINS_PER_AXIS);
    const yAxis = this.binnedAxis(y, 'y', HEATMAP_TARGET_BINS, MAX_HEATMAP_BINS_PER_AXIS);
    this.colorColumn();
    this.limit();
    const { ctes, src } = this.baseCtes(
      [
        [axisKey(xAxis), 'gx'],
        [axisKey(yAxis), 'gy'],
      ],
      null,
      [xAxis.column, yAxis.column],
      null,
      () => '',
    );
    return (
      `WITH ${ctes.join(',\n')}\n` +
      `SELECT ${axisStart(xAxis, 'gx')} AS x, ${axisEnd(xAxis, 'gx')} AS x_end, ` +
      `${axisStart(yAxis, 'gy')} AS y, ${axisEnd(yAxis, 'gy')} AS y_end, ${this.countAgg('')} AS count\n` +
      `FROM ${src}\nGROUP BY gx, gy\nORDER BY gx, gy`
    );
  }

  scatterChannels(): { x: CompileColumn; y: CompileColumn } {
    const why = 'scatter plots raw points';
    const y = this.spec.y;
    if (!y) this.fail('invalid_spec', 'scatter charts need y: the column for the vertical axis.', 'y');
    if (y.aggregate !== undefined) {
      this.fail('unsupported', `scatter plots raw points, so y.aggregate must be omitted; got "${y.aggregate}".`, 'y.aggregate');
    }
    this.noBinning(this.spec.x, 'x', why);
    this.noBinning(y, 'y', why);
    const x = this.column(this.spec.x, 'x');
    this.requirePositional(x, 'x');
    const yColumn = this.column(y, 'y');
    this.requirePositional(yColumn, 'y');
    return { x, y: yColumn };
  }

  scatter(): string {
    if (this.cube !== null) this.fail('unsupported', 'scatter plots raw points, which a cube does not hold.', 'mark');
    const channels = this.scatterChannels();
    const color = this.colorColumn();
    const limitValue = this.limit() ?? SCATTER_MAX_POINTS;
    const { ctes, src } = this.baseCtes(
      [
        [quoteIdent(channels.x.name), 'gx'],
        [quoteIdent(channels.y.name), 'gy'],
      ],
      null,
      [channels.x, channels.y],
      color,
      () => 'count(*)',
    );
    const limit = this.params.bigint(limitValue);
    const colorSelect = color ? ', gc AS color, other AS color_other' : '';
    return `WITH ${ctes.join(',\n')}\nSELECT gx AS x, gy AS y${colorSelect}\nFROM ${src}\nLIMIT ${limit}`;
  }

  scatterCount(): string {
    const channels = this.scatterChannels();
    this.colorColumn();
    this.limit();
    const predicates = filterPredicates(this.spec.filters, this.index, this.params);
    predicates.push(`${quoteIdent(channels.x.name)} IS NOT NULL`, `${quoteIdent(channels.y.name)} IS NOT NULL`);
    return `SELECT count(*) AS ${ROW_COUNT_COLUMN}\nFROM ${this.table}${whereClause(predicates)}`;
  }

  line(opts: ChartCompileOptions): string {
    const pixelWidth = opts.pixelWidth ?? DEFAULT_PIXEL_WIDTH;
    if (!Number.isInteger(pixelWidth) || pixelWidth < 1 || pixelWidth > MAX_PIXEL_WIDTH) {
      throw new CompileError('invalid_spec', `pixelWidth must be an integer from 1 to ${MAX_PIXEL_WIDTH}; got ${pixelWidth}.`);
    }
    const { x } = this.spec;
    const column = this.column(x, 'x');
    this.requirePositional(column, 'x');
    let axis: Axis;
    if (isTemporalType(column.type)) {
      axis = this.timeAxis(x, column, 'x', { mode: 'finest', max: LINE_AUTO_MAX_BUCKETS });
    } else {
      this.noTimeUnitOnNumber(x, column, 'x');
      if (x.bin === undefined) {
        axis = { kind: 'raw', column };
      } else if (x.bin === 'auto') {
        const min = typeof column.min === 'number' ? column.min : null;
        const max = typeof column.max === 'number' ? column.max : null;
        const width = min === null || max === null ? 1 : niceBinWidth(min, max, pixelWidth, column.type === 'integer');
        axis = this.binAxis(column, width);
      } else {
        axis = this.binAxis(column, x.bin);
      }
    }
    const measure = this.measure();
    const color = this.colorColumn();
    this.limit();
    const { ctes, src } = this.baseCtes([[axisKey(axis), 'gx']], measure, [column], color, (a) => measure.agg(a));
    const width = this.params.double(pixelWidth);
    const xn = axis.kind === 'time' ? 'epoch_us(x)' : 'CAST(x AS DOUBLE)';
    const series = color ? 'color, color_other, ' : '';
    const window = (order: string) => `row_number() OVER (PARTITION BY ${series}px ORDER BY ${order})`;
    ctes.push(
      `__gg_agg AS (\n  SELECT ${axisStart(axis, 'gx')} AS x${color ? ', gc AS color, other AS color_other' : ''}, ${measure.agg('')} AS y\n` +
        `  FROM ${src} GROUP BY gx${color ? ', gc, other' : ''}\n)`,
      `__gg_xn AS (SELECT *, ${xn} AS xn FROM __gg_agg)`,
      `__gg_px AS (\n  SELECT a.*, CASE WHEN b.hi = b.lo THEN 0 ELSE least(floor((a.xn - b.lo) / (b.hi - b.lo) * ${width}), ${width} - 1) END AS px\n` +
        `  FROM __gg_xn AS a CROSS JOIN (SELECT min(xn) AS lo, max(xn) AS hi FROM __gg_xn) AS b\n)`,
      `__gg_m4 AS (\n  SELECT *,\n` +
        `    ${window('x ASC')} AS r_first,\n` +
        `    ${window('x DESC')} AS r_last,\n` +
        `    ${window('y ASC NULLS LAST, x ASC')} AS r_min,\n` +
        `    ${window('y DESC NULLS LAST, x ASC')} AS r_max\n` +
        `  FROM __gg_px\n)`,
    );
    return (
      `WITH ${ctes.join(',\n')}\n` +
      `SELECT x, y${color ? ', color, color_other' : ''}\nFROM __gg_m4\n` +
      `WHERE r_first = 1 OR r_last = 1 OR r_min = 1 OR r_max = 1\n` +
      `ORDER BY ${color ? 'color_other ASC, color ASC NULLS LAST, ' : ''}x`
    );
  }
}

/**
 * Compile a chart spec to one aggregate query over `table` (an SQL relation
 * reference supplied by the engine, e.g. a quoted view name; it is inserted
 * verbatim). Result columns per mark:
 *
 * | mark | columns |
 * | --- | --- |
 * | bar | x, y, [color, color_other] |
 * | histogram | x, x_end, y, [color, color_other] |
 * | line, area | x, y, [color, color_other] (M4-downsampled) |
 * | heatmap | x, x_end, y, y_end, count |
 * | scatter | x, y, [color, color_other] |
 *
 * `y` (the measure) is DOUBLE, except min/max of a date/timestamp column,
 * which keep the column type. Binned `x`/`x_end` are DOUBLE; time-bucketed
 * ones are TIMESTAMP. `color` keeps the column type and is NULL when
 * `color_other` is TRUE (the folded "Other" series).
 *
 * Throws `CompileError` for invalid specs, unknown columns and type misuse.
 */
export function compileChartQuery(
  table: string,
  spec: ChartSpecInput,
  columns: readonly CompileColumn[],
  opts: ChartCompileOptions = {},
): CompiledQuery {
  const compiler = new ChartCompiler(table, parseOrThrow(ChartSpecSchema, spec, 'chart spec'), columns);
  const sql = compiler.compile(opts);
  return { sql, params: compiler.params.values };
}

/**
 * Count the points a scatter spec would plot (filters applied, NULL x or y
 * dropped). The engine runs this first: if the count exceeds
 * `scatterPointLimit(spec)` it compiles `scatterAsHeatmap(spec)` instead and
 * reports the fallback to the renderer; otherwise it compiles the scatter
 * spec itself, whose LIMIT is then only a safety cap.
 */
export function compileScatterCountQuery(
  table: string,
  spec: ChartSpecInput,
  columns: readonly CompileColumn[],
): CompiledQuery {
  const parsed = parseOrThrow(ChartSpecSchema, spec, 'chart spec');
  if (parsed.mark !== 'scatter') {
    throw new CompileError('unsupported', `compileScatterCountQuery needs a scatter spec, got "${parsed.mark}".`, 'mark');
  }
  const compiler = new ChartCompiler(table, parsed, columns);
  const sql = compiler.scatterCount();
  return { sql, params: compiler.params.values };
}

/** Largest number of raw points a scatter spec may return before falling back to a heatmap. */
export function scatterPointLimit(spec: ChartSpecInput): number {
  return Math.min(spec.limit ?? SCATTER_MAX_POINTS, SCATTER_MAX_POINTS);
}

/** The heatmap that replaces a scatter spec with too many points: same axes and filters, auto bins. */
export function scatterAsHeatmap(spec: ChartSpecInput): ChartSpec {
  const parsed = parseOrThrow(ChartSpecSchema, spec, 'chart spec');
  if (!parsed.y) throw new CompileError('invalid_spec', 'scatter charts need y: the column for the vertical axis.', 'y');
  const y: YField = { column: parsed.y.column };
  return { mark: 'heatmap', x: { column: parsed.x.column }, y, filters: parsed.filters };
}

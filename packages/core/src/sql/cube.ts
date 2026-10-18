import { isNumericType, isTemporalType, type CompileColumn } from '../spec/column.js';
import { ChartSpecSchema, type ChartSpec, type ChartSpecInput } from '../spec/chart.js';
import { CrossfilterDimensionSchema, type CrossfilterDimension } from '../spec/crossfilter.js';
import { FilterSchema, type FilterInput } from '../spec/filter.js';
import { z } from 'zod';
import { autoTimeUnit, niceBinWidth, numericBinCount, parseTemporal, timeBucketCount } from './bins.js';
import { ROW_COUNT_COLUMN, type CompiledQuery } from './builder.js';
import {
  ChartCompiler,
  HEATMAP_TARGET_BINS,
  HISTOGRAM_TARGET_BINS,
  LINE_AUTO_MAX_BUCKETS,
  type ChartCompileOptions,
} from './chart.js';
import { CompileError } from './errors.js';
import { parseOrThrow, whereClause } from './where.js';

/*
 * Cross-filter cubes (Mosaic-style pre-aggregation for the active brush).
 *
 * While view A is brushed on dimension d, every other view V re-queries
 * with A's selection plus the filters it already had. A cube for V is one
 * GROUP BY over the table with V's other filters, keyed by V's own group
 * keys and `gb` (the bin of d), holding decomposable partial aggregates.
 * Any brush on A that is aligned to the bins of d is then answered by
 * re-summing the cube's cells whose `gb` the brush covers: a scan of a few
 * thousand rows instead of the whole table. count, sum, avg (sum and count),
 * min and max all decompose, so every mark except scatter can be answered.
 *
 *   build  = compileChartCubeBuild(table, specWithOtherFilters, columns, d)
 *   answer = compileChartCubeAnswer(cubeName, sameSpec, columns, d, brushFilter, opts)
 *
 * The answer has exactly the columns and row order of
 * `compileChartQuery(table, { ...spec, filters: [...spec.filters, brushFilter] })`;
 * aggregates are equal except for floating-point summation order.
 */

/** Columns a cube estimate may use: the compiler's view of the profile plus distinct counts. */
export type CubeColumn = CompileColumn & { readonly distinctCount?: number | undefined };

function dimensionOf(value: CrossfilterDimension): CrossfilterDimension {
  return parseOrThrow(CrossfilterDimensionSchema, value, 'cross-filter dimension');
}

function chartCompiler(table: string, spec: ChartSpecInput, columns: readonly CompileColumn[], cube: ChartCompiler['cube']): ChartCompiler {
  return new ChartCompiler(table, parseOrThrow(ChartSpecSchema, spec, 'chart spec'), columns, cube);
}

/**
 * The cube of a chart over `dimension`: `SELECT <group keys>, gb, n[, nn, s, mn, mx]
 * FROM table WHERE <spec.filters> GROUP BY ALL`. `spec.filters` must not include
 * the brushed view's selection; their order does not matter (equal sets give equal SQL).
 * Pass the same `opts` as to the answer: a line chart's automatic numeric bins
 * depend on `pixelWidth`.
 */
export function compileChartCubeBuild(
  table: string,
  spec: ChartSpecInput,
  columns: readonly CompileColumn[],
  dimension: CrossfilterDimension,
  opts: ChartCompileOptions = {},
): CompiledQuery {
  const compiler = chartCompiler(table, spec, columns, { phase: 'build', dimension: dimensionOf(dimension) });
  compiler.compile(opts);
  if (compiler.cubeBuild === null) throw new CompileError('unsupported', `${compiler.mark} charts cannot be pre-aggregated.`, 'mark');
  return compiler.cubeBuild;
}

/**
 * The chart's rows from its cube (`cube` is the cube relation, inserted
 * verbatim) for the brushed selection (null: no selection, every cell). The
 * selection must filter the dimension column and be aligned to its bins (see
 * `cubeSelection`); otherwise this throws `CompileError('unsupported')`.
 */
export function compileChartCubeAnswer(
  cube: string,
  spec: ChartSpecInput,
  columns: readonly CompileColumn[],
  dimension: CrossfilterDimension,
  selection: FilterInput | null,
  opts: ChartCompileOptions = {},
): CompiledQuery {
  const parsedSelection = selection === null ? null : parseOrThrow(FilterSchema, selection, 'selection');
  const compiler = chartCompiler(cube, spec, columns, {
    phase: 'answer',
    dimension: dimensionOf(dimension),
    selection: parsedSelection,
  });
  const sql = compiler.compile(opts);
  return { sql, params: compiler.params.values };
}

/** Row counts per bin of `dimension` under `filters`: the grid's count cube. */
export function compileCountCubeBuild(
  table: string,
  filters: readonly FilterInput[],
  columns: readonly CompileColumn[],
  dimension: CrossfilterDimension,
): CompiledQuery {
  const dim = dimensionOf(dimension);
  const parsed = parseOrThrow(z.array(FilterSchema), filters, 'filters');
  // A chart compiler over a stand-in spec provides the filter, gb and selection SQL.
  const compiler = new ChartCompiler(table, { mark: 'bar', x: { column: dim.column }, filters: parsed }, columns, {
    phase: 'build',
    dimension: dim,
  });
  compiler.baseCtes([], null, [], null, () => '');
  const build = compiler.cubeBuild;
  if (build === null) throw new CompileError('unsupported', 'Could not build the count cube.', 'filters');
  return build;
}

/** `SELECT row_count` (BIGINT) from a count cube for the brushed selection (null: all rows). */
export function compileCountCubeAnswer(
  cube: string,
  columns: readonly CompileColumn[],
  dimension: CrossfilterDimension,
  selection: FilterInput | null,
): CompiledQuery {
  const dim = dimensionOf(dimension);
  const compiler = new ChartCompiler(cube, { mark: 'bar', x: { column: dim.column }, filters: [] }, columns, {
    phase: 'answer',
    dimension: dim,
    selection: null,
  });
  const predicate = compiler.selectionPredicate(dim, selection === null ? null : parseOrThrow(FilterSchema, selection, 'selection'));
  return {
    sql: `SELECT CAST(coalesce(sum(n), 0) AS BIGINT) AS ${ROW_COUNT_COLUMN}\nFROM ${cube}${whereClause(predicate === null ? [] : [predicate])}`,
    params: compiler.params.values,
  };
}

/* --------------------------------------------------------------------------
 * Size estimates
 * ------------------------------------------------------------------------ */

function profileOf(columns: readonly CubeColumn[], name: string): CubeColumn | undefined {
  return columns.find((column) => column.name === name);
}

function numericRange(column: CubeColumn): [number, number] | null {
  return typeof column.min === 'number' && typeof column.max === 'number' ? [column.min, column.max] : null;
}

function temporalRange(column: CubeColumn): [number, number] | null {
  const lo = parseTemporal(column.min ?? null);
  const hi = parseTemporal(column.max ?? null);
  return lo === null || hi === null ? null : [lo, hi];
}

/** Distinct values (plus NULL) of a raw column, or null when unknown. */
function valueCount(column: CubeColumn | undefined): number | null {
  if (!column) return null;
  if (column.type === 'boolean') return 3;
  return column.distinctCount === undefined ? null : column.distinctCount + 1;
}

/** Bins of `dimension` that the column's profiled range touches, plus NULL. */
export function dimensionCardinality(columns: readonly CubeColumn[], dimension: CrossfilterDimension): number | null {
  const column = profileOf(columns, dimension.column);
  if (!column) return null;
  switch (dimension.bin.kind) {
    case 'value':
      return valueCount(column);
    case 'width': {
      const range = numericRange(column);
      return range ? numericBinCount(range[0], range[1], dimension.bin.width) + 1 : null;
    }
    case 'time': {
      const range = temporalRange(column);
      return range ? timeBucketCount(range[0], range[1], dimension.bin.unit) + 1 : null;
    }
  }
}

/** Group keys the chart's x (or heatmap y) produces, from the profile. */
function axisCardinality(spec: ChartSpec, field: ChartSpec['x'], columns: readonly CubeColumn[], target: number | null): number | null {
  const column = profileOf(columns, field.column);
  if (!column) return null;
  if (isTemporalType(column.type) && (field.timeUnit !== undefined || target !== null || spec.mark === 'line' || spec.mark === 'area')) {
    const range = temporalRange(column);
    if (!range) return null;
    const unit =
      field.timeUnit ??
      autoTimeUnit(column.min, column.max, column.type, target === null ? { mode: 'finest', max: LINE_AUTO_MAX_BUCKETS } : { mode: 'closest', target });
    return timeBucketCount(range[0], range[1], unit) + 1;
  }
  if (isNumericType(column.type) && (field.bin !== undefined || target !== null)) {
    const range = numericRange(column);
    if (!range) return null;
    const width =
      typeof field.bin === 'number'
        ? field.bin
        : niceBinWidth(range[0], range[1], target ?? 1000, column.type === 'integer');
    return numericBinCount(range[0], range[1], width) + 1;
  }
  return valueCount(column);
}

/**
 * Upper bound on a chart cube's cells (group keys x dimension bins) from the
 * profile, or null when the profile cannot tell. The engine skips cubes that
 * would hold too many cells, since re-summing them would cost about as much
 * as scanning the table.
 */
export function estimateCubeCells(spec: ChartSpecInput, columns: readonly CubeColumn[], dimension: CrossfilterDimension): number | null {
  const parsed = parseOrThrow(ChartSpecSchema, spec, 'chart spec');
  const dims = dimensionCardinality(columns, dimension);
  let keys: number | null;
  switch (parsed.mark) {
    case 'scatter':
      return null;
    case 'bar':
      keys = axisCardinality(parsed, parsed.x, columns, null);
      break;
    case 'histogram':
      keys = axisCardinality(parsed, parsed.x, columns, HISTOGRAM_TARGET_BINS);
      break;
    case 'line':
    case 'area':
      keys = axisCardinality(parsed, parsed.x, columns, null);
      break;
    case 'heatmap': {
      const x = axisCardinality(parsed, parsed.x, columns, HEATMAP_TARGET_BINS);
      const y = parsed.y ? axisCardinality(parsed, parsed.y, columns, HEATMAP_TARGET_BINS) : null;
      keys = x === null || y === null ? null : x * y;
      break;
    }
  }
  const color = parsed.color ? valueCount(profileOf(columns, parsed.color.column)) : 1;
  if (dims === null || keys === null || color === null) return null;
  return dims * keys * color;
}

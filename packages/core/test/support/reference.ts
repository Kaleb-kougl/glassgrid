/*
 * Straightforward JS reference semantics for the SQL compiler. Each function
 * takes the in-memory model of a table plus the same spec the compiler gets,
 * and returns rows in the order the compiled query must return them.
 *
 * Aggregates carry an exact rational "rank" next to their double value. All
 * generated numbers are k/scale for small integers k, so DuckDB's doubles
 * order exactly like these rationals (equal rationals give bit-identical
 * correctly rounded doubles; distinct ones differ by far more than an ulp).
 * That lets the reference reproduce tie-breaks exactly.
 */
import {
  autoTimeUnit,
  DEFAULT_BAR_LIMIT,
  HEATMAP_TARGET_BINS,
  HISTOGRAM_TARGET_BINS,
  LINE_AUTO_MAX_BUCKETS,
  MAX_COLOR_SERIES,
  niceBinWidth,
  type ChartSpecInput,
  type ColumnProfile,
  type FilterInput,
  type RowQueryInput,
  type TimeUnit,
  type TimeUnitStrategy,
} from '../../src/index.js';
import { compareCells, compareNullsLast, numericScale, type Cell, type TestColumn, type TestTable } from './model.js';
import { type ResultRow } from './db.js';

type Row = readonly Cell[];

interface FieldInputLike {
  readonly column: string;
  readonly bin?: number | 'auto' | undefined;
  readonly timeUnit?: TimeUnit | undefined;
}

interface Rat {
  readonly n: number;
  readonly d: number;
}

interface AggValue {
  readonly value: Cell;
  readonly rank: Rat | null;
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

function columnIndex(table: TestTable, name: string): number {
  const index = table.columns.findIndex((c) => c.name === name);
  if (index < 0) throw new Error(`Reference: unknown column ${name}`);
  return index;
}

function columnOf(table: TestTable, name: string): TestColumn {
  const column = table.columns[columnIndex(table, name)];
  if (!column) throw new Error(`Reference: unknown column ${name}`);
  return column;
}

function cell(row: Row, index: number): Cell {
  return row[index] ?? null;
}

function num(value: Cell): number {
  if (typeof value !== 'number') throw new Error(`Reference: expected a number, got ${String(value)}`);
  return value;
}

/* ---------------------------------------------------------------- filters */

/** Temporal bound to epoch ms: numbers are epoch ms; ISO strings are UTC wall clock. */
export function temporalMs(value: number | string): number {
  if (typeof value === 'number') return value;
  let iso = value.replace(' ', 'T');
  if (iso.length > 10 && !iso.endsWith('Z')) iso += 'Z';
  return Date.parse(iso);
}

function matches(table: TestTable, filter: FilterInput, row: Row): boolean {
  const column = columnOf(table, filter.column);
  const value = cell(row, columnIndex(table, filter.column));
  const temporal = column.type === 'date' || column.type === 'timestamp';
  switch (filter.kind) {
    case 'isNull':
      return value === null;
    case 'notNull':
      return value !== null;
    case 'range': {
      if (value === null) return false;
      const v = num(value);
      if (filter.min !== undefined) {
        const min = temporal ? temporalMs(filter.min) : num(filter.min);
        if ((filter.minInclusive ?? true) ? v < min : v <= min) return false;
      }
      if (filter.max !== undefined) {
        const max = temporal ? temporalMs(filter.max) : num(filter.max);
        if ((filter.maxInclusive ?? true) ? v > max : v >= max) return false;
      }
      return true;
    }
    case 'in':
    case 'notIn': {
      const listed = filter.values.some((candidate) => {
        if (candidate === null || value === null) return candidate === value;
        if (temporal && typeof candidate !== 'boolean') return temporalMs(candidate) === value;
        return candidate === value;
      });
      return filter.kind === 'in' ? listed : !listed;
    }
  }
}

export function applyFilters(table: TestTable, filters: readonly FilterInput[] | undefined): Row[] {
  return table.rows.filter((row) => (filters ?? []).every((filter) => matches(table, filter, row)));
}

export function refCount(table: TestTable, filters: readonly FilterInput[]): number {
  return applyFilters(table, filters).length;
}

/* ------------------------------------------------------------------- rows */

export function refRows(table: TestTable, query: RowQueryInput): Row[] {
  const rows = applyFilters(table, query.filters);
  const keys: { index: number; desc: boolean }[] = [];
  const seen = new Set<number>();
  for (const key of query.sort ?? []) {
    const index = columnIndex(table, key.column);
    if (seen.has(index)) continue;
    seen.add(index);
    keys.push({ index, desc: key.direction === 'desc' });
  }
  if (keys.length > 0) {
    table.columns.forEach((_, index) => {
      if (!seen.has(index)) keys.push({ index, desc: false });
    });
    rows.sort((a, b) => {
      for (const { index, desc } of keys) {
        const x = cell(a, index);
        const y = cell(b, index);
        // NULLs last in both directions.
        if (x === null || y === null) {
          const order = compareNullsLast(x, y);
          if (order !== 0) return order;
          continue;
        }
        const order = compareCells(x, y);
        if (order !== 0) return desc ? -order : order;
      }
      return 0;
    });
  }
  return rows.slice(query.offset, query.offset + query.limit);
}

/* ------------------------------------------------------------- aggregates */

function compareRat(a: Rat, b: Rat): number {
  return Math.sign(a.n * b.d - b.n * a.d);
}

/** Descending by rank, NULL ranks last. */
function compareRankDesc(a: Rat | null, b: Rat | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return -compareRat(a, b);
}

/** Ascending by rank, NULL ranks last. */
function compareRankAsc(a: Rat | null, b: Rat | null): number {
  if (a === null) return b === null ? 0 : 1;
  if (b === null) return -1;
  return compareRat(a, b);
}

type Agg = (rows: readonly Row[]) => AggValue;

function makeAgg(table: TestTable, y: ChartSpecInput['y']): Agg {
  if (!y) return (rows) => ({ value: rows.length, rank: { n: rows.length, d: 1 } });
  const index = columnIndex(table, y.column);
  const column = columnOf(table, y.column);
  const scale = numericScale(column.type);
  const temporal = column.type === 'date' || column.type === 'timestamp';
  const nonNull = (rows: readonly Row[]) => rows.map((row) => cell(row, index)).filter((v) => v !== null);
  const units = (v: Cell) => (temporal ? num(v) : Math.round(num(v) * scale));
  const unitScale = temporal ? 1 : scale;
  switch (y.aggregate) {
    case 'count':
      return (rows) => {
        const n = nonNull(rows).length;
        return { value: n, rank: { n, d: 1 } };
      };
    case 'sum':
    case 'avg':
      return (rows) => {
        const values = nonNull(rows);
        if (values.length === 0) return { value: null, rank: null };
        const total = values.reduce<number>((acc, v) => acc + units(v), 0);
        const d = y.aggregate === 'avg' ? unitScale * values.length : unitScale;
        return { value: total / d, rank: { n: total, d } };
      };
    case 'min':
    case 'max':
      return (rows) => {
        const values = nonNull(rows).map(units);
        if (values.length === 0) return { value: null, rank: null };
        const best = y.aggregate === 'min' ? Math.min(...values) : Math.max(...values);
        return { value: temporal ? best : best / unitScale, rank: { n: best, d: unitScale } };
      };
    case undefined:
      throw new Error('Reference: y.aggregate missing');
  }
}

const countAgg: Agg = (rows) => ({ value: rows.length, rank: { n: rows.length, d: 1 } });

/* --------------------------------------------------------------- grouping */

function keyOf(values: readonly Cell[]): string {
  return JSON.stringify(values.map((v) => (v === null ? null : [typeof v, v])));
}

function groupBy<T, K extends readonly Cell[]>(rows: readonly T[], key: (row: T) => K): { key: K; rows: T[] }[] {
  const groups = new Map<string, { key: K; rows: T[] }>();
  for (const row of rows) {
    const k = key(row);
    const id = keyOf(k);
    const group = groups.get(id);
    if (group) group.rows.push(row);
    else groups.set(id, { key: k, rows: [row] });
  }
  return [...groups.values()];
}

interface Fold {
  readonly color: Cell;
  readonly other: boolean;
}

/** Top 8 colour series by `agg` over `rows` (desc, NULLs last; ties by value asc, NULLs last); the rest is Other. */
function makeFold(table: TestTable, rows: readonly Row[], column: string, agg: Agg): (row: Row) => Fold {
  const index = columnIndex(table, column);
  const ranked = groupBy(rows, (row) => [cell(row, index)] as const)
    .map((group) => ({ value: group.key[0], rank: agg(group.rows).rank }))
    .sort((a, b) => compareRankDesc(a.rank, b.rank) || compareNullsLast(a.value, b.value));
  const top = new Set(ranked.slice(0, MAX_COLOR_SERIES).map((s) => keyOf([s.value])));
  return (row) => {
    const value = cell(row, index);
    return top.has(keyOf([value])) ? { color: value, other: false } : { color: null, other: true };
  };
}

function compareFold(a: Fold, b: Fold): number {
  return Number(a.other) - Number(b.other) || compareNullsLast(a.color, b.color);
}

/* ------------------------------------------------------------------- time */

export function truncMs(ms: number, unit: TimeUnit): number {
  switch (unit) {
    case 'hour':
      return Math.floor(ms / HOUR) * HOUR;
    case 'day':
      return Math.floor(ms / DAY) * DAY;
    case 'month': {
      const d = new Date(ms);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    }
  }
}

function addUnit(ms: number, unit: TimeUnit): number {
  switch (unit) {
    case 'hour':
      return ms + HOUR;
    case 'day':
      return ms + DAY;
    case 'month': {
      const d = new Date(ms);
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    }
  }
}

/* ------------------------------------------------------------------- axes */

interface RefAxis {
  readonly index: number;
  /** Group key of a non-null value. */
  readonly key: (value: Cell) => number;
  readonly start: (key: number) => number;
  readonly end: (key: number) => number;
  /** Numeric position used for M4 pixel columns (µs for time). */
  readonly position: (start: number) => number;
}

function profileOf(profile: readonly ColumnProfile[], name: string): ColumnProfile {
  const p = profile.find((c) => c.name === name);
  if (!p) throw new Error(`Reference: no profile for ${name}`);
  return p;
}

function binnedAxis(
  table: TestTable,
  profile: readonly ColumnProfile[],
  field: FieldInputLike,
  target: number | null,
  strategy: TimeUnitStrategy,
): RefAxis {
  const index = columnIndex(table, field.column);
  const column = columnOf(table, field.column);
  const p = profileOf(profile, field.column);
  if (column.type === 'date' || column.type === 'timestamp') {
    const unit = field.timeUnit ?? autoTimeUnit(p.min, p.max, column.type, strategy);
    return {
      index,
      key: (v) => truncMs(num(v), unit),
      start: (k) => k,
      end: (k) => addUnit(k, unit),
      position: (start) => start * 1000,
    };
  }
  if (field.bin === undefined && target === null) {
    return { index, key: num, start: (k) => k, end: (k) => k, position: (s) => s };
  }
  const width =
    typeof field.bin === 'number'
      ? field.bin
      : typeof p.min === 'number' && typeof p.max === 'number'
        ? niceBinWidth(p.min, p.max, target ?? 1, column.type === 'integer')
        : 1;
  return {
    index,
    key: (v) => Math.floor(num(v) / width),
    start: (k) => k * width,
    end: (k) => (k + 1) * width,
    position: (s) => s,
  };
}

/* ----------------------------------------------------------------- charts */

export function refBar(table: TestTable, spec: ChartSpecInput): ResultRow[] {
  const rows = applyFilters(table, spec.filters);
  const xIndex = columnIndex(table, spec.x.column);
  const unit = spec.x.timeUnit;
  const xOf = (row: Row): Cell => {
    const v = cell(row, xIndex);
    return v === null || unit === undefined ? v : truncMs(num(v), unit);
  };
  const agg = makeAgg(table, spec.y);
  const ranked = groupBy(rows, (row) => [xOf(row)] as const)
    .map((group) => ({ x: group.key[0], rows: group.rows, agg: agg(group.rows) }))
    .sort((a, b) => compareRankDesc(a.agg.rank, b.agg.rank) || compareNullsLast(a.x, b.x));
  const limit = spec.limit ?? DEFAULT_BAR_LIMIT;
  const top = ranked.slice(0, limit);
  const folded = ranked.slice(limit).flatMap((group) => group.rows);
  const other = spec.other === true;
  // With other: named bars, then one Other bar (x NULL, x_other TRUE) over every folded row.
  const bars = [
    ...top.map((g) => ({ x: g.x, xOther: false, rows: g.rows })),
    ...(other && folded.length > 0 ? [{ x: null, xOther: true, rows: folded }] : []),
  ];
  const xFields = (bar: { x: Cell; xOther: boolean }): ResultRow => (other ? { x: bar.x, x_other: bar.xOther } : { x: bar.x });
  if (!spec.color) return bars.map((bar) => ({ ...xFields(bar), y: agg(bar.rows).value }));
  const fold = makeFold(table, rows, spec.color.column, agg);
  return bars.flatMap((bar) =>
    groupBy(bar.rows, (row) => {
      const f = fold(row);
      return [f.color, f.other] as const;
    })
      .map((sub) => ({ fold: { color: sub.key[0], other: sub.key[1] }, rows: sub.rows }))
      .sort((a, b) => compareFold(a.fold, b.fold))
      .map((sub) => ({ ...xFields(bar), color: sub.fold.color, color_other: sub.fold.other, y: agg(sub.rows).value })),
  );
}

export function refHistogram(table: TestTable, profile: readonly ColumnProfile[], spec: ChartSpecInput): ResultRow[] {
  const axis = binnedAxis(table, profile, spec.x, HISTOGRAM_TARGET_BINS, { mode: 'closest', target: HISTOGRAM_TARGET_BINS });
  const rows = applyFilters(table, spec.filters).filter((row) => cell(row, axis.index) !== null);
  const agg = makeAgg(table, spec.y);
  const fold = spec.color ? makeFold(table, rows, spec.color.column, agg) : null;
  return groupBy(rows, (row) => {
    const f = fold?.(row);
    return [axis.key(cell(row, axis.index)), f?.color ?? null, f?.other ?? false] as const;
  })
    .sort(
      (a, b) =>
        a.key[0] - b.key[0] || compareFold({ color: a.key[1], other: a.key[2] }, { color: b.key[1], other: b.key[2] }),
    )
    .map((g) => ({
      x: axis.start(g.key[0]),
      x_end: axis.end(g.key[0]),
      ...(fold ? { color: g.key[1], color_other: g.key[2] } : {}),
      y: agg(g.rows).value,
    }));
}

export function refHeatmap(table: TestTable, profile: readonly ColumnProfile[], spec: ChartSpecInput): ResultRow[] {
  if (!spec.y) throw new Error('Reference: heatmap needs y');
  const strategy: TimeUnitStrategy = { mode: 'closest', target: HEATMAP_TARGET_BINS };
  const xAxis = binnedAxis(table, profile, spec.x, HEATMAP_TARGET_BINS, strategy);
  const yAxis = binnedAxis(table, profile, spec.y, HEATMAP_TARGET_BINS, strategy);
  const rows = applyFilters(table, spec.filters).filter(
    (row) => cell(row, xAxis.index) !== null && cell(row, yAxis.index) !== null,
  );
  return groupBy(rows, (row) => [xAxis.key(cell(row, xAxis.index)), yAxis.key(cell(row, yAxis.index))] as const)
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1])
    .map((g) => ({
      x: xAxis.start(g.key[0]),
      x_end: xAxis.end(g.key[0]),
      y: yAxis.start(g.key[1]),
      y_end: yAxis.end(g.key[1]),
      count: g.rows.length,
    }));
}

export function refLine(
  table: TestTable,
  profile: readonly ColumnProfile[],
  spec: ChartSpecInput,
  pixelWidth: number,
): ResultRow[] {
  const axis = binnedAxis(table, profile, spec.x, spec.x.bin === undefined ? null : pixelWidth, {
    mode: 'finest',
    max: LINE_AUTO_MAX_BUCKETS,
  });
  const rows = applyFilters(table, spec.filters).filter((row) => cell(row, axis.index) !== null);
  const agg = makeAgg(table, spec.y);
  const fold = spec.color ? makeFold(table, rows, spec.color.column, agg) : null;
  const points = groupBy(rows, (row) => {
    const f = fold?.(row);
    return [axis.key(cell(row, axis.index)), f?.color ?? null, f?.other ?? false] as const;
  }).map((g) => {
    const x = axis.start(g.key[0]);
    return { x, xn: axis.position(x), color: g.key[1], other: g.key[2], agg: agg(g.rows) };
  });
  if (points.length === 0) return [];
  const lo = Math.min(...points.map((p) => p.xn));
  const hi = Math.max(...points.map((p) => p.xn));
  const pixel = (xn: number) =>
    hi === lo ? 0 : Math.min(Math.floor(((xn - lo) / (hi - lo)) * pixelWidth), pixelWidth - 1);
  const kept = new Set<(typeof points)[number]>();
  for (const { rows: members } of groupBy(points, (p) => [p.color, p.other, pixel(p.xn)] as const)) {
    const byX = [...members].sort((a, b) => a.x - b.x);
    const min = [...members].sort((a, b) => compareRankAsc(a.agg.rank, b.agg.rank) || a.x - b.x)[0];
    const max = [...members].sort((a, b) => compareRankDesc(a.agg.rank, b.agg.rank) || a.x - b.x)[0];
    for (const p of [byX[0], byX[byX.length - 1], min, max]) if (p) kept.add(p);
  }
  return [...kept]
    .sort((a, b) => compareFold(a, b) || a.x - b.x)
    .map((p) => ({ x: p.x, y: p.agg.value, ...(fold ? { color: p.color, color_other: p.other } : {}) }));
}

export function refScatter(table: TestTable, spec: ChartSpecInput): ResultRow[] {
  if (!spec.y) throw new Error('Reference: scatter needs y');
  const xIndex = columnIndex(table, spec.x.column);
  const yIndex = columnIndex(table, spec.y.column);
  const rows = applyFilters(table, spec.filters).filter((row) => cell(row, xIndex) !== null && cell(row, yIndex) !== null);
  const fold = spec.color ? makeFold(table, rows, spec.color.column, countAgg) : null;
  return rows.map((row) => {
    const f = fold?.(row);
    return { x: cell(row, xIndex), y: cell(row, yIndex), ...(f ? { color: f.color, color_other: f.other } : {}) };
  });
}

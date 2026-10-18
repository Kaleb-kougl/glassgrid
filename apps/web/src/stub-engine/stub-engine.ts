import { Bool, DateDay, Float64, Int32, Table, TimestampMillisecond, Utf8, type DataType, type Vector } from 'apache-arrow';
import {
  addTime,
  AggregateSpecSchema,
  compileChartQuery,
  DEFAULT_BAR_LIMIT,
  isCompileError,
  isNumericType,
  isTemporalType,
  MAX_COLOR_SERIES,
  parseTemporal,
  RequestFiltersSchema,
  resolveAxis,
  scatterAsHeatmap,
  scatterPointLimit,
  tableIdForFile,
  toFileHandle,
  truncateTime,
  type ChartSpec,
  type ColumnType,
  type ColumnTypeOverride,
  type CubeColumn,
  type FileHandle,
  type Filter,
  type FilterInput,
  type FilterValue,
  type OpenCsvResult,
  type ResolvedAxis,
  type SortKey,
  type TableColumnProfile,
  type TableHandle,
  type TableId,
  type YField,
} from '@glassgrid/core';
import { EngineError, type AggregateResult, type EngineClientLike, type FetchPage, type ProfileResult } from '@glassgrid/app';
import { vectorFromValues } from '@glassgrid/ui';
import { castCell, DUCKDB_TYPES, formatTemporal, sampleTrips, type Cell, type StubColumn } from './sample-trips';

/*
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ TEMPORARY STUB ENGINE: delete when the DuckDB-WASM worker client     │
 * │ (packages/engine) is wired into apps/web (M4 integration).           │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * An in-memory `EngineClientLike` over one tiny fixed dataset
 * (sample-trips.ts), so the shared app can be exercised in a browser without
 * DuckDB. Whatever file is opened, its name and size are kept but the rows
 * are always the sample's. It answers every request the app makes with the
 * result shapes of the real compiler (docs/m1-compiler.md, "SQL shape per
 * mark"), validating specs with the real compiler first (so errors and
 * disabled marks match), but it computes in plain JS: no cubes, no Parquet,
 * no M4 downsampling, no superseding (answers are immediate).
 */

interface Registered {
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

interface StubTable {
  readonly handle: TableHandle;
  readonly source: readonly StubColumn[];
  /** Effective columns: the source with the type overrides applied. */
  columns: StubColumn[];
  overrides: ColumnTypeOverride[];
}

const SAMPLE_ID = 'sample-trips';
const SAMPLE_FILE_NAME = 'sample-trips.csv';
/** About what the sample would weigh as a CSV. */
const SAMPLE_SIZE_BYTES = 12_288;

function arrowType(type: ColumnType): DataType {
  switch (type) {
    case 'integer':
      return new Int32();
    case 'float':
    case 'decimal':
      return new Float64();
    case 'boolean':
      return new Bool();
    case 'date':
      return new DateDay();
    case 'timestamp':
      return new TimestampMillisecond();
    case 'text':
      return new Utf8();
  }
}

/** CSP-safe (no `new Function`, which the web build's policy refuses): see `vectorFromValues`. */
function vector(values: readonly Cell[], type: DataType): Vector {
  return vectorFromValues(values, type) as Vector;
}

function tableOf(columns: Record<string, Vector>): Table {
  return new Table(columns);
}

function hex(seed: string, length: number): string {
  let h = 2166136261;
  let out = '';
  while (out.length < length) {
    for (const char of `${seed}${out.length}`) h = Math.imul(h ^ char.charCodeAt(0), 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}

function sleep(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new EngineError('cancelled', 'Request was cancelled'));
      return;
    }
    setTimeout(() => {
      if (signal?.aborted) reject(new EngineError('cancelled', 'Request was cancelled'));
      else resolve();
    }, 0);
  });
}

// ---------------------------------------------------------------------------
// Filters and sorting

function boundOf(bound: number | string, type: ColumnType): number | string | null {
  if (isTemporalType(type)) return parseTemporal(bound);
  if (isNumericType(type)) return typeof bound === 'number' ? bound : Number(bound);
  return bound;
}

function sameValue(cell: Cell, value: FilterValue, type: ColumnType): boolean {
  if (cell === null || value === null) return cell === null && value === null;
  if (isTemporalType(type) && typeof value !== 'boolean') return parseTemporal(value) === cell;
  return cell === value;
}

function matches(cell: Cell, filter: Filter, type: ColumnType): boolean {
  switch (filter.kind) {
    case 'isNull':
      return cell === null;
    case 'notNull':
      return cell !== null;
    case 'in':
      return filter.values.some((value) => sameValue(cell, value, type));
    case 'notIn':
      return !filter.values.some((value) => sameValue(cell, value, type));
    case 'range': {
      if (cell === null || typeof cell === 'boolean') return false;
      const min = filter.min === undefined ? null : boundOf(filter.min, type);
      const max = filter.max === undefined ? null : boundOf(filter.max, type);
      if (min !== null && (filter.minInclusive ? cell < min : cell <= min)) return false;
      if (max !== null && (filter.maxInclusive ? cell > max : cell >= max)) return false;
      return true;
    }
  }
}

function compareCells(a: Cell, b: Cell): number {
  if (a === b) return 0;
  if (a === null) return 1; // NULLS LAST
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

// ---------------------------------------------------------------------------
// Aggregates

type Rows = readonly number[];

interface Group {
  key: Cell;
  end: Cell;
  rows: number[];
}

function groupBy(rows: Rows, keyOf: (row: number) => { key: Cell; end: Cell } | null): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const k = keyOf(row);
    if (!k) continue;
    const id = JSON.stringify(k.key);
    let group = groups.get(id);
    if (!group) {
      group = { key: k.key, end: k.end, rows: [] };
      groups.set(id, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

class StubTableView {
  constructor(readonly table: StubTable) {}

  column(name: string): StubColumn {
    const column = this.table.columns.find((candidate) => candidate.name === name);
    if (!column) throw new EngineError('unknown_column', `No column named ${JSON.stringify(name)}`);
    return column;
  }

  get rowCount(): number {
    return this.table.columns[0]?.values.length ?? 0;
  }

  filtered(filters: readonly FilterInput[] | undefined): number[] {
    const parsed = RequestFiltersSchema.parse(filters ?? []);
    const checks = parsed.map((filter) => ({ filter, column: this.column(filter.column) }));
    const rows: number[] = [];
    for (let row = 0; row < this.rowCount; row += 1) {
      if (checks.every(({ filter, column }) => matches(column.values[row] ?? null, filter, column.type))) rows.push(row);
    }
    return rows;
  }

  /** Group key of `row` on `axis` (null drops the row: NULL bins and time buckets). */
  axisKey(axis: ResolvedAxis, keepNull: boolean): (row: number) => { key: Cell; end: Cell } | null {
    const values = this.column(axis.column.name).values;
    return (row) => {
      const value = values[row] ?? null;
      if (value === null) return keepNull ? { key: null, end: null } : null;
      switch (axis.kind) {
        case 'raw':
          return { key: value, end: value };
        case 'width': {
          const k = Math.floor(Number(value) / axis.width);
          return { key: k * axis.width, end: (k + 1) * axis.width };
        }
        case 'time': {
          const start = truncateTime(Number(value), axis.unit);
          return { key: start, end: addTime(start, axis.unit) };
        }
      }
    };
  }

  axisType(axis: ResolvedAxis): DataType {
    if (axis.kind === 'width') return new Float64();
    if (axis.kind === 'time') return new TimestampMillisecond();
    return isNumericType(axis.column.type) ? new Float64() : arrowType(axis.column.type);
  }

  measure(y: YField | undefined): (rows: Rows) => number | null {
    if (!y) return (rows) => rows.length;
    const values = this.column(y.column).values;
    const present = (rows: Rows) => rows.map((row) => values[row] ?? null).filter((value): value is number => typeof value === 'number');
    switch (y.aggregate ?? 'count') {
      case 'count':
        return (rows) => rows.filter((row) => (values[row] ?? null) !== null).length;
      case 'sum':
        return (rows) => {
          const xs = present(rows);
          return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0);
        };
      case 'avg':
        return (rows) => {
          const xs = present(rows);
          return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
        };
      case 'min':
        return (rows) => {
          const xs = present(rows);
          return xs.length === 0 ? null : Math.min(...xs);
        };
      case 'max':
        return (rows) => {
          const xs = present(rows);
          return xs.length === 0 ? null : Math.max(...xs);
        };
    }
  }

  /** The colour split: `seriesOf(row)` → named series (top 8 by the measure) or the folded "Other". */
  series(spec: ChartSpec, rows: Rows, measure: (rows: Rows) => number | null) {
    if (!spec.color) return null;
    const axis: ResolvedAxis =
      spec.color.timeUnit !== undefined && isTemporalType(this.column(spec.color.column).type)
        ? { kind: 'time', column: { name: spec.color.column, type: this.column(spec.color.column).type }, unit: spec.color.timeUnit }
        : { kind: 'raw', column: { name: spec.color.column, type: this.column(spec.color.column).type } };
    const groups = groupBy(rows, this.axisKey(axis, true));
    const ranked = groups
      .map((group) => ({ key: group.key, v: measure(group.rows) }))
      .sort((a, b) => compareCells(b.v, a.v) || compareCells(a.key, b.key))
      .slice(0, MAX_COLOR_SERIES);
    const named = new Set(ranked.map((entry) => JSON.stringify(entry.key)));
    const keyOf = this.axisKey(axis, true);
    return {
      type: this.axisType(axis),
      of: (row: number) => {
        const key = keyOf(row)?.key ?? null;
        return named.has(JSON.stringify(key)) ? { color: key, other: false } : { color: null, other: true };
      },
    };
  }

  /** Splits a group's rows by series, named series by value then "Other" (the compiler's order). */
  static bySeries(rows: Rows, of: (row: number) => { color: Cell; other: boolean }) {
    const parts = new Map<string, { color: Cell; other: boolean; rows: number[] }>();
    for (const row of rows) {
      const s = of(row);
      const id = JSON.stringify([s.other, s.color]);
      let part = parts.get(id);
      if (!part) {
        part = { ...s, rows: [] };
        parts.set(id, part);
      }
      part.rows.push(row);
    }
    return [...parts.values()].sort((a, b) => Number(a.other) - Number(b.other) || compareCells(a.color, b.color));
  }

  aggregate(spec: ChartSpec): { table: Table; mark: ChartSpec['mark']; fellBackToHeatmap: boolean } {
    const columns = this.cubeColumns();
    const rows = this.filtered(spec.filters);
    const measure = this.measure(spec.mark === 'heatmap' || spec.mark === 'scatter' ? undefined : spec.y);
    const x = resolveAxis(spec, 'x', columns);
    if (!x) throw new EngineError('bad_request', `The stub engine cannot chart ${spec.x.column} as ${spec.mark}`, 'x');
    const series = spec.mark === 'heatmap' ? null : this.series(spec, rows, measure);
    const out: Record<string, Cell[]> = {};
    const push = (name: string, value: Cell) => (out[name] ??= []).push(value);
    const types: Record<string, DataType> = {};
    const colors = series ? ['color', 'color_other'] : [];
    let names: string[];

    switch (spec.mark) {
      case 'bar': {
        const groups = groupBy(rows, this.axisKey(x, true))
          .map((group) => ({ ...group, v: measure(group.rows) }))
          .sort((a, b) => compareCells(b.v, a.v) || compareCells(a.key, b.key));
        const limit = spec.limit ?? DEFAULT_BAR_LIMIT;
        const bars: { x: Cell; other: boolean; rows: number[] }[] = groups.slice(0, limit).map((group) => ({ x: group.key, other: false, rows: group.rows }));
        const rest = groups.slice(limit).flatMap((group) => group.rows);
        if (spec.other && rest.length > 0) bars.push({ x: null, other: true, rows: rest });
        for (const bar of bars) {
          const parts = series ? StubTableView.bySeries(bar.rows, series.of) : [{ color: null, other: false, rows: bar.rows }];
          for (const part of parts) {
            push('x', bar.x);
            if (spec.other) push('x_other', bar.other);
            if (series) {
              push('color', part.color);
              push('color_other', part.other);
            }
            push('y', measure(part.rows));
          }
        }
        types['x'] = this.axisType(x);
        names = ['x', ...(spec.other ? ['x_other'] : []), ...colors, 'y'];
        break;
      }
      case 'histogram':
      case 'line':
      case 'area':
      case 'scatter': {
        if (spec.mark === 'scatter') {
          const y = resolveAxis(spec, 'y', columns);
          if (!y) throw new EngineError('bad_request', 'scatter charts need y: the column for the vertical axis.', 'y');
          const xs = this.column(x.column.name).values;
          const ys = this.column(y.column.name).values;
          const points = rows.filter((row) => (xs[row] ?? null) !== null && (ys[row] ?? null) !== null);
          if (points.length > scatterPointLimit(spec)) return { ...this.aggregate(scatterAsHeatmap(spec)), fellBackToHeatmap: true };
          for (const row of points) {
            push('x', xs[row] ?? null);
            push('y', ys[row] ?? null);
            if (series) {
              const s = series.of(row);
              push('color', s.color);
              push('color_other', s.other);
            }
          }
          types['x'] = this.axisType(x);
          types['y'] = this.axisType(y);
          names = ['x', 'y', ...colors];
          break;
        }
        const groups = groupBy(rows, this.axisKey(x, false)).sort((a, b) => compareCells(a.key, b.key));
        for (const group of groups) {
          const parts = series ? StubTableView.bySeries(group.rows, series.of) : [{ color: null, other: false, rows: group.rows }];
          for (const part of parts) {
            push('x', group.key);
            if (spec.mark === 'histogram') push('x_end', group.end);
            if (series) {
              push('color', part.color);
              push('color_other', part.other);
            }
            push('y', measure(part.rows));
          }
        }
        types['x'] = this.axisType(x);
        types['x_end'] = this.axisType(x);
        names = spec.mark === 'histogram' ? ['x', 'x_end', ...colors, 'y'] : ['x', ...colors, 'y'];
        break;
      }
      case 'heatmap': {
        const y = resolveAxis(spec, 'y', columns);
        if (!y) throw new EngineError('bad_request', 'heatmap charts need y: the column for the vertical axis.', 'y');
        const xKey = this.axisKey(x, false);
        const yKey = this.axisKey(y, false);
        const cells = groupBy(rows, (row) => {
          const gx = xKey(row);
          const gy = yKey(row);
          return gx && gy ? { key: JSON.stringify([gx.key, gx.end, gy.key, gy.end]), end: null } : null;
        });
        const decoded = cells
          .map((cell) => ({ bounds: JSON.parse(String(cell.key)) as [Cell, Cell, Cell, Cell], count: cell.rows.length }))
          .sort((a, b) => compareCells(a.bounds[0], b.bounds[0]) || compareCells(a.bounds[2], b.bounds[2]));
        for (const { bounds, count } of decoded) {
          push('x', bounds[0]);
          push('x_end', bounds[1]);
          push('y', bounds[2]);
          push('y_end', bounds[3]);
          push('count', count);
        }
        types['x'] = this.axisType(x);
        types['x_end'] = this.axisType(x);
        types['y'] = this.axisType(y);
        types['y_end'] = this.axisType(y);
        types['count'] = new Float64();
        names = ['x', 'x_end', 'y', 'y_end', 'count'];
        break;
      }
    }

    const vectors: Record<string, Vector> = {};
    for (const name of names) {
      const values = out[name] ?? [];
      const type =
        types[name] ??
        (name === 'x_other' || name === 'color_other' ? new Bool() : name === 'color' ? (series?.type ?? new Utf8()) : new Float64());
      vectors[name] = vector(values, type);
    }
    return { table: tableOf(vectors), mark: spec.mark, fellBackToHeatmap: false };
  }

  page(offset: number, limit: number, sort: readonly SortKey[], filters: readonly FilterInput[] | undefined): Table {
    const rows = this.filtered(filters);
    if (sort.length > 0) {
      const keys = sort.map((key) => ({ values: this.column(key.column).values, sign: key.direction === 'desc' ? -1 : 1 }));
      rows.sort((a, b) => {
        for (const { values, sign } of keys) {
          const va = values[a] ?? null;
          const vb = values[b] ?? null;
          // NULLS LAST in both directions, as DuckDB's default.
          if (va === null || vb === null) {
            const c = compareCells(va, vb);
            if (c !== 0) return c;
            continue;
          }
          const c = compareCells(va, vb) * sign;
          if (c !== 0) return c;
        }
        return a - b;
      });
    }
    const slice = rows.slice(offset, offset + limit);
    const vectors: Record<string, Vector> = {};
    for (const column of this.table.columns) vectors[column.name] = vector(slice.map((row) => column.values[row] ?? null), arrowType(column.type));
    return tableOf(vectors);
  }

  cubeColumns(): CubeColumn[] {
    return this.profileColumns().map(({ name, type, min, max, distinctCount, duckdbType }) => ({ name, type, min, max, distinctCount, duckdbType }));
  }

  profileColumns(): TableColumnProfile[] {
    return this.table.columns.map((column) => {
      const present = column.values.filter((value): value is Exclude<Cell, null> => value !== null);
      const sorted = [...present].sort(compareCells);
      const extreme = (value: Exclude<Cell, null> | undefined) => {
        if (value === undefined) return null;
        if (typeof value === 'number' && (column.type === 'date' || column.type === 'timestamp')) return formatTemporal(value, column.type);
        return value;
      };
      return {
        name: column.name,
        type: column.type,
        duckdbType: DUCKDB_TYPES[column.type],
        nullFraction: column.values.length === 0 ? 0 : (column.values.length - present.length) / column.values.length,
        distinctCount: new Set(present).size,
        min: extreme(sorted[0]),
        max: extreme(sorted.at(-1)),
      };
    });
  }
}

/**
 * The stub engine plus what the web platform needs from it: registering a
 * picked or dropped `File` (kept by name and size; rows from the sample) and
 * the sample dataset.
 */
export interface StubEngine {
  readonly engine: EngineClientLike;
  /** Registers a File; resolves with its handle like the desktop dialog does. */
  registerFile(file: Pick<File, 'name' | 'size' | 'lastModified'>): Promise<OpenCsvResult>;
  readonly samples: readonly { id: string; label: string; detail: string }[];
  openSample(id: string): Promise<OpenCsvResult>;
}

export function createStubEngine(options: { newId?: () => string } = {}): StubEngine {
  const newId = options.newId ?? (() => crypto.randomUUID());
  const files = new Map<FileHandle, Registered>();
  const tables = new Map<TableId, StubTable>();

  const register = (entry: Registered): OpenCsvResult => {
    const handle = toFileHandle(newId());
    files.set(handle, entry);
    return { status: 'opened', file: { handle, displayName: entry.fileName, sizeBytes: entry.sizeBytes } };
  };

  const view = (table: TableId): StubTableView => {
    const found = tables.get(table);
    if (!found) throw new EngineError('unknown_table', `Unknown table ${table}`);
    return new StubTableView(found);
  };

  const handleOf = (table: StubTable): TableHandle => ({
    ...table.handle,
    rowCount: table.source[0]?.values.length ?? 0,
    columns: table.columns.map((column) => ({ name: column.name, type: column.type, duckdbType: DUCKDB_TYPES[column.type] })),
    ...(table.overrides.length > 0 ? { typeOverrides: table.overrides.map((override) => ({ ...override })) } : {}),
  });

  const timed = async <T>(signal: AbortSignal | undefined, work: () => T): Promise<T & { engineMs: number }> => {
    await sleep(signal);
    const start = performance.now();
    const result = work();
    return { ...result, engineMs: performance.now() - start };
  };

  const engine: EngineClientLike = {
    async open(file, options = {}) {
      await sleep(options.signal);
      const registered = files.get(file);
      if (!registered) throw new EngineError('unknown_handle', 'Unknown file handle');
      const id = tableIdForFile(file);
      let table = tables.get(id);
      if (!table) {
        const source = sampleTrips();
        table = {
          handle: {
            id,
            file,
            fileName: registered.fileName,
            fingerprint: {
              sizeBytes: registered.sizeBytes,
              mtimeMs: registered.mtimeMs,
              headTailSha256: hex(`${registered.fileName}:${registered.sizeBytes}`, 64),
              key: hex(`${registered.fileName}:${registered.mtimeMs}`, 32),
            },
            usingParquetCache: false,
            columns: [],
          },
          source,
          columns: source,
          overrides: [],
        };
        tables.set(id, table);
      }
      return { table: handleOf(table), engineMs: 0 };
    },

    profile(table, options = {}): Promise<ProfileResult> {
      return timed(options.signal, () => {
        const v = view(table);
        return { rowCount: v.rowCount, columns: v.profileColumns(), cached: false };
      });
    },

    count(table, options = {}) {
      return timed(options.signal, () => ({ rowCount: view(table).filtered(options.filters).length, cached: false, fromCube: false }));
    },

    pageFetcher(table, pageView = {}): FetchPage {
      return (offset, limit, signal) => timed(signal, () => ({ table: view(table).page(offset, limit, pageView.sort ?? [], pageView.filters), cached: false }));
    },

    setColumnTypes(table, overrides, options = {}) {
      return timed(options.signal, () => {
        const found = tables.get(table);
        if (!found) throw new EngineError('unknown_table', `Unknown table ${table}`);
        const wanted = new Map(overrides.map((override) => [override.column, override.type]));
        const results = overrides.map((override) => ({ column: override.column, type: override.type, duckdbType: DUCKDB_TYPES[override.type], failedCasts: 0 }));
        found.columns = found.source.map((column) => {
          const to = wanted.get(column.name);
          if (to === undefined || to === column.type) return column;
          const values = column.values.map((value) => castCell(value, column.type, to));
          const result = results.find((entry) => entry.column === column.name);
          if (result) result.failedCasts = column.values.filter((value, i) => value !== null && values[i] === null).length;
          return { name: column.name, type: to, values };
        });
        found.overrides = overrides.filter((override) => found.source.some((column) => column.name === override.column && column.type !== override.type)).map((o) => ({ ...o }));
        return { table: handleOf(found), columns: results };
      });
    },

    async aggregate(table, spec, options = {}): Promise<AggregateResult> {
      const parsed = AggregateSpecSchema.safeParse(spec);
      if (!parsed.success) throw new EngineError('bad_request', `Invalid chart spec: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
      const { pixelWidth, ...chart } = parsed.data;
      const result = await timed(options.signal, () => {
        const v = view(table);
        try {
          // The real compiler validates the spec (unknown columns, types, marks), as the engine does.
          compileChartQuery('stub', chart, v.cubeColumns(), pixelWidth === undefined ? {} : { pixelWidth });
        } catch (error) {
          if (isCompileError(error)) throw new EngineError('bad_request', error.message, error.path);
          throw error;
        }
        return { ...v.aggregate(chart), cached: false };
      });
      return { ...result, fromCube: false };
    },

    async prepareCrossfilter(_table, plan, options = {}) {
      await sleep(options.signal);
      return { cubes: plan.targets.map(() => ({ status: 'skipped' as const, reason: 'The stub engine builds no cubes' })), engineMs: 0 };
    },

    async closeTable(table) {
      await sleep();
      tables.delete(table);
    },

    onRestarted: () => () => undefined,
    onEvent: () => () => undefined,
  };

  return {
    engine,
    registerFile: (file) => Promise.resolve(register({ fileName: file.name, sizeBytes: file.size, mtimeMs: Math.max(0, Math.floor(file.lastModified)) })),
    samples: [{ id: SAMPLE_ID, label: 'Sample taxi trips', detail: '240 rows (stub engine)' }],
    openSample: (id) =>
      Promise.resolve(
        id === SAMPLE_ID
          ? register({ fileName: SAMPLE_FILE_NAME, sizeBytes: SAMPLE_SIZE_BYTES, mtimeMs: Date.UTC(2024, 3, 1) })
          : { status: 'failed', message: `No sample named ${id}` },
      ),
  };
}

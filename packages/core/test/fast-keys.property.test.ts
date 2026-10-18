/*
 * Property tests for the compiler's cheaper group keys (docs/m1-compiler.md,
 * "Group keys"): hour and day buckets keyed on integers when the profile says
 * the column is a TIMESTAMP (or DATE), and the heatmap's single cell key when
 * the profile bounds both numeric axes.
 *
 * 1. The JS-reference properties of compiler.property.test.ts, rerun with the
 *    engine's DuckDB types in the profile (so the integer keys are used), plus
 *    the cube answer of those charts against their plain query.
 * 2. Old vs new SQL on edge data the reference cannot model: microsecond
 *    timestamps on both sides of hour/day/month edges and of the epoch,
 *    years 1 to 9999, DuckDB's extreme timestamps, ±infinity, NULLs, and
 *    empty and single-row tables. The old SQL is what the compiler emits
 *    without DuckDB types (date_trunc keys) or without numeric min/max (two
 *    heatmap keys); results must match exactly: same columns, same DuckDB
 *    types, same values, same order.
 */
import { type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  binStart,
  compileChartCubeAnswer,
  compileChartCubeBuild,
  compileChartQuery,
  quoteIdent,
  type ChartSpecInput,
  type CompileColumn,
  type CompiledQuery,
  type CrossfilterDimension,
  type FilterInput,
  type TimeUnit,
} from '../src/index.js';
import { filterArb, heatmapSpecArb, histogramSpecArb, lineSpecArb, tableArb } from './support/arbitraries.js';
import { loadTable, openConnection, runQuery, TABLE, type ResultRow } from './support/db.js';
import { profileOf, SQL_TYPE, type Cell, type TestTable } from './support/model.js';
import { refHeatmap, refHistogram, refLine } from './support/reference.js';

const SEED = 20261018;
const NUM_RUNS = 200;
const TIMEOUT_MS = 180_000;
const RUN = { seed: SEED, numRuns: NUM_RUNS, endOnFailure: true } as const;
const CUBE = quoteIdent('fast "keys" cube');

let connection: DuckDBConnection;

beforeAll(async () => {
  connection = await openConnection();
});

afterAll(() => {
  connection.closeSync();
});

function close(a: Cell, b: Cell): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return Object.is(a, b);
}

function sameRows(actual: readonly ResultRow[], expected: readonly ResultRow[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((row, i) => {
      const other = expected[i];
      if (!other) return false;
      const keys = Object.keys(other);
      return Object.keys(row).length === keys.length && keys.every((key) => close(row[key] ?? null, other[key] ?? null));
    })
  );
}

function describeFailure(queries: Record<string, CompiledQuery>, actual: unknown, expected: unknown): string {
  return [
    ...Object.entries(queries).flatMap(([name, query]) => [`${name}:`, query.sql, `params: ${JSON.stringify(query.params)}`]),
    `actual:   ${JSON.stringify(actual)}`,
    `expected: ${JSON.stringify(expected)}`,
  ].join('\n');
}

/** The profile the engine would send: the model's, plus each column's DuckDB type. */
function typedProfile(table: TestTable): CompileColumn[] {
  return profileOf(table).map((column) => ({ ...column, duckdbType: SQL_TYPE[column.type] }));
}

/* ----------------------------------------------- 1. reference properties */

describe('integer time keys and the cell key vs the JS reference (typed profile)', () => {
  it('line/area: time buckets plus M4', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb.chain((table) => fc.tuple(fc.constant(table), lineSpecArb(table))),
        async ([table, { spec, pixelWidth }]) => {
          await loadTable(connection, table);
          const compiled = compileChartQuery(TABLE, spec, typedProfile(table), { pixelWidth });
          const expected = refLine(table, profileOf(table), spec, pixelWidth);
          const actual = await runQuery(connection, compiled);
          if (!sameRows(actual, expected)) expect.fail(describeFailure({ compiled }, actual, expected));
        },
      ),
      RUN,
    );
  }, TIMEOUT_MS);

  it('histogram: numeric bins and time buckets', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb.chain((table) => fc.tuple(fc.constant(table), histogramSpecArb(table))),
        async ([table, spec]) => {
          await loadTable(connection, table);
          const compiled = compileChartQuery(TABLE, spec, typedProfile(table));
          const expected = refHistogram(table, profileOf(table), spec);
          const actual = await runQuery(connection, compiled);
          if (!sameRows(actual, expected)) expect.fail(describeFailure({ compiled }, actual, expected));
        },
      ),
      RUN,
    );
  }, TIMEOUT_MS);

  it('heatmap: cells of every axis combination', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb.chain((table) => fc.tuple(fc.constant(table), heatmapSpecArb(table))),
        async ([table, spec]) => {
          await loadTable(connection, table);
          const compiled = compileChartQuery(TABLE, spec, typedProfile(table));
          const expected = refHeatmap(table, profileOf(table), spec);
          const actual = await runQuery(connection, compiled);
          if (!sameRows(actual, expected)) expect.fail(describeFailure({ compiled }, actual, expected));
        },
      ),
      RUN,
    );
  }, TIMEOUT_MS);

  it('cube answers of those charts equal their plain query with the brush', async () => {
    const brushArb = (table: TestTable): fc.Arbitrary<{ dimension: CrossfilterDimension; selection: FilterInput | null }> =>
      fc.constantFrom(...table.columns).chain((column) => {
        const value = fc
          .option(
            filterArb(table).filter((filter) => filter.column === column.name),
            { nil: null, freq: 6 },
          )
          .map((selection) => ({ dimension: { column: column.name, bin: { kind: 'value' as const } }, selection }));
        if (column.type !== 'integer' && column.type !== 'float' && column.type !== 'decimal') return value;
        const width = fc.constantFrom(0.25, 0.5, 1, 3).chain((w) =>
          fc
            .option(
              fc.tuple(fc.integer({ min: -60, max: 0 }), fc.integer({ min: 1, max: 60 })).map(
                ([lo, hi]): FilterInput => ({ kind: 'range', column: column.name, min: binStart(lo, w), max: binStart(hi, w), minInclusive: true, maxInclusive: false }),
              ),
              { nil: null, freq: 6 },
            )
            .map((selection) => ({ dimension: { column: column.name, bin: { kind: 'width' as const, width: w } }, selection })),
        );
        return fc.oneof(value, width);
      });
    const chartArb = (table: TestTable) =>
      fc.oneof(
        histogramSpecArb(table).map((spec) => ({ spec, pixelWidth: 1000 })),
        heatmapSpecArb(table).map((spec) => ({ spec, pixelWidth: 1000 })),
        lineSpecArb(table),
      );
    await fc.assert(
      fc.asyncProperty(
        tableArb.chain((table) => fc.tuple(fc.constant(table), chartArb(table), brushArb(table))),
        async ([table, { spec, pixelWidth }, { dimension, selection }]) => {
          await loadTable(connection, table);
          const profile = typedProfile(table);
          const build = compileChartCubeBuild(TABLE, spec, profile, dimension, { pixelWidth });
          await connection.run(`CREATE OR REPLACE TABLE ${CUBE} AS ${build.sql}`, build.params as DuckDBValue[]);
          const answer = compileChartCubeAnswer(CUBE, spec, profile, dimension, selection, { pixelWidth });
          const plain = compileChartQuery(TABLE, { ...spec, filters: [...(spec.filters ?? []), ...(selection ? [selection] : [])] }, profile, { pixelWidth });
          const actual = await runQuery(connection, answer);
          const expected = await runQuery(connection, plain);
          if (!sameRows(actual, expected)) expect.fail(describeFailure({ build, answer, plain }, actual, expected));
        },
      ),
      RUN,
    );
  }, TIMEOUT_MS);
});

/* -------------------------------------------------- 2. old vs new SQL */

const EDGE = quoteIdent('edge "keys" table');
const US_PER_HOUR = 3_600_000_000n;
const US_PER_DAY = 86_400_000_000n;
/** DuckDB's TIMESTAMP range (microseconds since the epoch). */
const TS_MIN = -9_223_372_022_400_000_000n; // 290309-12-22 (BC) 00:00:00
const TS_MAX = 9_223_372_036_854_775_806n; // 294247-01-10 04:00:54.775806

type Stamp = bigint | 'infinity' | '-infinity' | null;

function us(iso: string): bigint {
  return BigInt(Date.parse(`${iso}Z`)) * 1000n;
}

/** Bucket edges (UTC) where a µs either side changes the hour, day or month; around the epoch; far years. */
const ANCHORS: bigint[] = [
  0n,
  us('1969-12-31T23:00:00'),
  us('1969-12-31T00:00:00'),
  us('1969-12-01T00:00:00'),
  us('1969-07-20T20:17:00'),
  us('1900-02-28T23:00:00'),
  us('1900-03-01T00:00:00'),
  us('2000-02-29T00:00:00'),
  us('2024-02-29T23:00:00'),
  us('2024-03-01T00:00:00'),
  us('2024-03-10T02:00:00'),
  us('2024-11-03T01:00:00'),
  us('2024-12-31T23:00:00'),
  us('2025-01-01T00:00:00'),
  us('0001-01-01T00:00:00'),
  us('9999-12-31T23:00:00'),
];

const stampArb: fc.Arbitrary<Stamp> = fc.oneof(
  { arbitrary: fc.tuple(fc.constantFrom(...ANCHORS), fc.constantFrom(-1n, 0n, 1n, US_PER_HOUR - 1n, -US_PER_HOUR, US_PER_DAY, 1_800_000_000n)).map(([a, d]) => a + d), weight: 8 },
  { arbitrary: fc.bigInt({ min: us('1960-01-01T00:00:00'), max: us('1980-01-01T00:00:00') }), weight: 3 },
  { arbitrary: fc.bigInt({ min: us('0001-01-01T00:00:00'), max: us('9999-12-31T23:59:59') }), weight: 1 },
  { arbitrary: fc.constantFrom<Stamp>('infinity', '-infinity'), weight: 1 },
  { arbitrary: fc.constant<Stamp>(null), weight: 2 },
);

/** Days since the epoch for DATE cells, kept within the TIMESTAMP range so bucket starts are representable. */
type Day = number | 'infinity' | '-infinity' | null;
const dayArb: fc.Arbitrary<Day> = fc.oneof(
  { arbitrary: fc.integer({ min: -800, max: 800 }), weight: 6 },
  { arbitrary: fc.integer({ min: -719_162, max: 2_932_896 }), weight: 2 }, // 0001-01-01 .. 9999-12-31
  { arbitrary: fc.constantFrom<Day>('infinity', '-infinity'), weight: 1 },
  { arbitrary: fc.constant<Day>(null), weight: 2 },
);

interface EdgeRow {
  ts: Stamp;
  d: Day;
  v: number | null;
  c: string | null;
  x: number | null;
  y: number | null;
}

const edgeRowArb: fc.Arbitrary<EdgeRow> = fc.record({
  ts: stampArb,
  d: dayArb,
  v: fc.option(fc.integer({ min: -80, max: 80 }).map((k) => k / 8), { nil: null, freq: 5 }),
  c: fc.option(fc.constantFrom('a', 'b', 'c', 'Other'), { nil: null, freq: 5 }),
  x: fc.option(fc.integer({ min: -200, max: 200 }).map((k) => k / 4), { nil: null, freq: 6 }),
  y: fc.option(fc.integer({ min: -20, max: 20 }), { nil: null, freq: 6 }),
});

/** 0 to 40 rows, often 0 or 1. */
const edgeRowsArb = fc.oneof(
  { arbitrary: fc.constant<EdgeRow[]>([]), weight: 1 },
  { arbitrary: edgeRowArb.map((row) => [row]), weight: 2 },
  { arbitrary: fc.array(edgeRowArb, { minLength: 2, maxLength: 40 }), weight: 7 },
);

function stampSql(value: Stamp): string {
  if (value === null) return 'CAST(NULL AS TIMESTAMP)';
  if (typeof value === 'string') return `CAST('${value}' AS TIMESTAMP)`;
  return `make_timestamp(CAST(${value} AS BIGINT))`;
}

function daySql(value: Day): string {
  if (value === null) return 'CAST(NULL AS DATE)';
  if (typeof value === 'string') return `CAST('${value}' AS DATE)`;
  return `CAST(DATE '1970-01-01' + ${value} AS DATE)`;
}

const num = (value: number | null, type: string) => (value === null ? `CAST(NULL AS ${type})` : `CAST(${value} AS ${type})`);

async function loadEdge(rows: readonly EdgeRow[]): Promise<CompileColumn[]> {
  await connection.run(`CREATE OR REPLACE TABLE ${EDGE} (ts TIMESTAMP, d DATE, v DOUBLE, c VARCHAR, x DOUBLE, y INTEGER)`);
  if (rows.length > 0) {
    const tuples = rows.map(
      (row) =>
        `(${stampSql(row.ts)}, ${daySql(row.d)}, ${num(row.v, 'DOUBLE')}, ${row.c === null ? 'NULL' : `'${row.c}'`}, ${num(row.x, 'DOUBLE')}, ${num(row.y, 'INTEGER')})`,
    );
    await connection.run(`INSERT INTO ${EDGE} VALUES ${tuples.join(', ')}`);
  }
  // The profile as the engine builds it: min/max as DuckDB prints temporal values, numbers as numbers.
  const reader = await connection.runAndReadAll(
    `SELECT CAST(min(ts) AS VARCHAR), CAST(max(ts) AS VARCHAR), CAST(min(d) AS VARCHAR), CAST(max(d) AS VARCHAR), min(v), max(v), min(x), max(x), min(y), max(y) FROM ${EDGE}`,
  );
  const [stats = []] = reader.getRowsJS();
  const at = (i: number) => (stats[i] ?? null) as string | number | null;
  return [
    { name: 'ts', type: 'timestamp', min: at(0), max: at(1), duckdbType: 'TIMESTAMP' },
    { name: 'd', type: 'date', min: at(2), max: at(3), duckdbType: 'DATE' },
    { name: 'v', type: 'float', min: at(4), max: at(5), duckdbType: 'DOUBLE' },
    { name: 'c', type: 'text', duckdbType: 'VARCHAR' },
    { name: 'x', type: 'float', min: at(6), max: at(7), duckdbType: 'DOUBLE' },
    { name: 'y', type: 'integer', min: at(8), max: at(9), duckdbType: 'INTEGER' },
  ];
}

/** Without DuckDB types and numeric min/max: the date_trunc keys and two heatmap keys. */
function legacyProfile(profile: readonly CompileColumn[]): CompileColumn[] {
  return profile.map((typed) => {
    const column: CompileColumn = { name: typed.name, type: typed.type, min: typed.min, max: typed.max };
    return column.type === 'timestamp' || column.type === 'date' ? column : { ...column, min: null, max: null };
  });
}

type Exact = { columns: string[]; rows: string[][] } | { error: true };

/**
 * Column names, DuckDB types and every value as DuckDB prints it: equal means
 * identical. A query that fails (a bucket end past DuckDB's last timestamp)
 * must fail with both keys.
 */
async function runExact(query: CompiledQuery): Promise<Exact> {
  try {
    const reader = await connection.runAndReadAll(query.sql, query.params as DuckDBValue[]);
    const columns = reader.columnNames().map((name, i) => `${name}:${reader.columnType(i).toString()}`);
    const rows = reader.getRows().map((row) => row.map((value) => (value === null ? 'NULL' : String(value))));
    return { columns, rows };
  } catch {
    return { error: true };
  }
}

const unitArb = (column: 'ts' | 'd'): fc.Arbitrary<TimeUnit | undefined> =>
  column === 'ts' ? fc.constantFrom<TimeUnit | undefined>('hour', 'hour', 'day', 'month', undefined) : fc.constantFrom<TimeUnit | undefined>('day', 'day', 'month', undefined);

function timeField(column: 'ts' | 'd', unit: TimeUnit | undefined): ChartSpecInput['x'] {
  return unit === undefined ? { column } : { column, timeUnit: unit };
}

const edgeFilterArb: fc.Arbitrary<FilterInput[]> = fc.array(
  fc.constantFrom<FilterInput>(
    { kind: 'range', column: 'v', min: 0 },
    { kind: 'range', column: 'x', max: 10, maxInclusive: false },
    { kind: 'notNull', column: 'c' },
    { kind: 'in', column: 'c', values: ['a', null] },
    { kind: 'range', column: 'ts', min: '1969-12-31 23:00:00', max: '2024-03-01' },
    { kind: 'range', column: 'd', min: '1969-06-01' },
  ),
  { maxLength: 2 },
);

const edgeMeasureArb: fc.Arbitrary<ChartSpecInput['y']> = fc.constantFrom<ChartSpecInput['y']>(
  undefined,
  { column: 'v', aggregate: 'sum' },
  { column: 'v', aggregate: 'avg' },
  { column: 'v', aggregate: 'min' },
  { column: 'ts', aggregate: 'max' },
  { column: 'c', aggregate: 'count' },
);

const edgeSpecArb: fc.Arbitrary<{ spec: ChartSpecInput; pixelWidth: number }> = fc.oneof(
  // line / area over a time axis, with or without a measure, colour and filters
  fc
    .tuple(fc.constantFrom('line' as const, 'area' as const), fc.constantFrom<'ts' | 'd'>('ts', 'ts', 'd'), edgeMeasureArb, fc.boolean(), edgeFilterArb, fc.constantFrom(1, 2, 3, 7, 40, 1000))
    .chain(([mark, column, y, color, filters, pixelWidth]) =>
      unitArb(column).map((unit) => ({
        spec: { mark, x: timeField(column, unit), ...(y ? { y } : {}), ...(color ? { color: { column: 'c' } } : {}), filters },
        pixelWidth,
      })),
    ),
  // histogram over a time axis
  fc
    .tuple(fc.constantFrom<'ts' | 'd'>('ts', 'd'), edgeMeasureArb, fc.boolean(), edgeFilterArb)
    .chain(([column, y, color, filters]) =>
      unitArb(column).map((unit) => ({
        spec: { mark: 'histogram' as const, x: timeField(column, unit), ...(y ? { y } : {}), ...(color ? { color: { column: 'c' } } : {}), filters },
        pixelWidth: 1000,
      })),
    ),
  // heatmap: numeric x numeric (one cell key) and time axes
  fc
    .tuple(fc.constantFrom<'x' | 'ts' | 'd'>('x', 'x', 'ts', 'd'), fc.constantFrom<'y' | 'x' | 'ts' | 'd'>('y', 'y', 'x', 'ts', 'd'), fc.constantFrom(0.25, 0.5, 1, 2.5, 7), fc.constantFrom(1, 2, 3), edgeFilterArb)
    .chain(([xc, yc, xw, yw, filters]) => {
      const axis = (column: 'x' | 'y' | 'ts' | 'd', width: number): fc.Arbitrary<ChartSpecInput['x']> =>
        column === 'ts' || column === 'd' ? unitArb(column).map((unit) => timeField(column, unit)) : fc.constant({ column, bin: width });
      return fc.tuple(axis(xc, xw), axis(yc, yw)).map(([x, y]) => ({ spec: { mark: 'heatmap' as const, x, y, filters }, pixelWidth: 1000 }));
    }),
);

describe('integer time keys and the cell key vs the old SQL (edge data)', () => {
  it('line/area, histogram and heatmap: identical columns, types, values and order', async () => {
    await fc.assert(
      fc.asyncProperty(edgeRowsArb, edgeSpecArb, async (rows, { spec, pixelWidth }) => {
        const profile = await loadEdge(rows);
        const fresh = compileChartQuery(EDGE, spec, profile, { pixelWidth });
        const old = compileChartQuery(EDGE, spec, legacyProfile(profile), { pixelWidth });
        const actual = await runExact(fresh);
        const expected = await runExact(old);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) expect.fail(describeFailure({ fresh, old }, actual, expected));
      }),
      { ...RUN, numRuns: 300 },
    );
  }, TIMEOUT_MS);

  it('the keys really change: the typed profile compiles integer and cell keys', async () => {
    const profile = await loadEdge([]);
    const line = compileChartQuery(EDGE, { mark: 'line', x: { column: 'ts', timeUnit: 'hour' } }, profile).sql;
    expect(line).toContain('// 3600000000');
    expect(compileChartQuery(EDGE, { mark: 'line', x: { column: 'ts', timeUnit: 'hour' } }, legacyProfile(profile)).sql).toContain(`date_trunc('hour'`);
    expect(compileChartQuery(EDGE, { mark: 'histogram', x: { column: 'ts', timeUnit: 'day' } }, profile).sql).toContain('CAST("ts" AS DATE) AS gx');
    expect(compileChartQuery(EDGE, { mark: 'histogram', x: { column: 'd', timeUnit: 'day' } }, profile).sql).toContain(`date_trunc('day', "d")`);
    const withRange = await loadEdge([{ ts: 0n, d: 0, v: 1, c: 'a', x: 1, y: 1 }]);
    expect(compileChartQuery(EDGE, { mark: 'heatmap', x: { column: 'x', bin: 1 }, y: { column: 'y', bin: 1 } }, withRange).sql).toContain('GROUP BY gxy');
  });

  it('bucket edges, the epoch, infinities and NULLs in one table', async () => {
    const stamps: Stamp[] = [
      ...ANCHORS.flatMap((a) => [a - 1n, a, a + 1n]),
      'infinity',
      '-infinity',
      'infinity',
      null,
    ];
    const rows: EdgeRow[] = stamps.map((ts, i) => ({ ts, d: i % 7 === 0 ? 'infinity' : i % 11 === 0 ? null : i * 37 - 600, v: (i % 9) - 4, c: ['a', 'b', null][i % 3] ?? null, x: (i % 13) - 6.5, y: (i % 5) - 2 }));
    const profile = await loadEdge(rows);
    const specs: ChartSpecInput[] = [
      { mark: 'line', x: { column: 'ts', timeUnit: 'hour' } },
      { mark: 'line', x: { column: 'ts', timeUnit: 'day' }, y: { column: 'v', aggregate: 'sum' }, color: { column: 'c' } },
      { mark: 'area', x: { column: 'ts', timeUnit: 'day' }, y: { column: 'd', aggregate: 'min' } },
      { mark: 'histogram', x: { column: 'ts', timeUnit: 'hour' }, color: { column: 'c' } },
      { mark: 'histogram', x: { column: 'ts', timeUnit: 'day' } },
      { mark: 'heatmap', x: { column: 'ts', timeUnit: 'hour' }, y: { column: 'd', timeUnit: 'day' } },
      { mark: 'heatmap', x: { column: 'x', bin: 0.5 }, y: { column: 'y', bin: 1 } },
    ];
    for (const spec of specs) {
      for (const pixelWidth of [3, 1000]) {
        const fresh = compileChartQuery(EDGE, spec, profile, { pixelWidth });
        const old = compileChartQuery(EDGE, spec, legacyProfile(profile), { pixelWidth });
        expect(fresh.sql).not.toBe(old.sql);
        const actual = await runExact(fresh);
        expect(actual).toEqual(await runExact(old));
        if ('error' in actual) expect.fail(`${spec.mark} failed on the edge table:\n${fresh.sql}`);
        expect(actual.rows.length).toBeGreaterThan(0);
      }
    }
  });

  it("DuckDB's first and last timestamps: the same buckets, or the same failure where a bucket end overflows", async () => {
    const tables: Stamp[][] = [
      [TS_MIN, TS_MIN + 1n, TS_MIN + US_PER_HOUR, -1n, 0n, null],
      [TS_MAX - 2n * US_PER_HOUR, TS_MAX - 2n * US_PER_HOUR - 1n, TS_MAX, 0n, 'infinity'],
    ];
    const specs: ChartSpecInput[] = [
      { mark: 'line', x: { column: 'ts', timeUnit: 'hour' } },
      { mark: 'line', x: { column: 'ts', timeUnit: 'day' } },
      { mark: 'histogram', x: { column: 'ts', timeUnit: 'hour' } },
      { mark: 'histogram', x: { column: 'ts', timeUnit: 'day' } },
    ];
    let succeeded = 0;
    for (const stamps of tables) {
      const profile = await loadEdge(stamps.map((ts) => ({ ts, d: 0, v: 1, c: 'a', x: 0, y: 0 })));
      for (const spec of specs) {
        const fresh = compileChartQuery(EDGE, spec, profile, { pixelWidth: 5 });
        const actual = await runExact(fresh);
        expect(actual, fresh.sql).toEqual(await runExact(compileChartQuery(EDGE, spec, legacyProfile(profile), { pixelWidth: 5 })));
        if (!('error' in actual)) succeeded += 1;
      }
    }
    expect(succeeded).toBeGreaterThanOrEqual(5);
  });
});

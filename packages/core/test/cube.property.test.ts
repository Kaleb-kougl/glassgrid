/*
 * Property tests for cross-filter cubes: on random tables, a chart answered
 * from its cube (built with the chart's own filters, then re-summed for a
 * brushed selection) returns the same rows, in the same order, as the plain
 * chart query with the selection added to its filters. Same for the grid's
 * count cube.
 */
import { type DuckDBConnection, type DuckDBValue } from '@duckdb/node-api';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compileChartCubeAnswer,
  compileChartCubeBuild,
  compileChartQuery,
  compileCountCubeAnswer,
  compileCountCubeBuild,
  cubeSelection,
  FilterSchema,
  quoteIdent,
  truncateTime,
  type ChartSpecInput,
  type CompiledQuery,
  type CrossfilterDimension,
  type FilterInput,
  type TimeUnit,
} from '../src/index.js';
import { barSpecArb, filterArb, filtersArb, heatmapSpecArb, histogramSpecArb, lineSpecArb, tableArb } from './support/arbitraries.js';
import { loadTable, openConnection, runQuery, TABLE, type ResultRow } from './support/db.js';
import { isoDate, isoTimestamp, profileOf, type Cell, type TestColumn, type TestTable } from './support/model.js';
import { refCount } from './support/reference.js';

const SEED = 20261018;
const NUM_RUNS = 200;
const TIMEOUT_MS = 180_000;
const RUN = { seed: SEED, numRuns: NUM_RUNS, endOnFailure: true } as const;
const CUBE = quoteIdent('cube "under" test');

let connection: DuckDBConnection;

beforeAll(async () => {
  connection = await openConnection();
});

afterAll(() => {
  connection.closeSync();
});

const isNumeric = (column: TestColumn) => column.type === 'integer' || column.type === 'float' || column.type === 'decimal';
const isTemporal = (column: TestColumn) => column.type === 'date' || column.type === 'timestamp';

interface Brush {
  readonly dimension: CrossfilterDimension;
  /** Null: the brushed view has no selection (yet). */
  readonly selection: FilterInput | null;
}

function nullTests(column: TestColumn): fc.Arbitrary<FilterInput> {
  return fc.constantFrom<FilterInput>({ kind: 'isNull', column: column.name }, { kind: 'notNull', column: column.name });
}

/** A brush on a width-binned numeric axis: bounds are k * width, min inclusive, max exclusive, either end open. */
function widthBrush(column: TestColumn): fc.Arbitrary<Brush> {
  // 0.1 and 0.3 are not exact in binary, so floor(v / w) and k * w disagree at some edges.
  return fc.constantFrom(0.1, 0.25, 0.3, 0.5, 1, 2.5, 3).chain((width) => {
    const dimension: CrossfilterDimension = { column: column.name, bin: { kind: 'width', width } };
    const k = fc.option(fc.integer({ min: -70, max: 70 }), { nil: undefined, freq: 5 });
    const range = fc
      .tuple(k, k)
      .filter(([lo, hi]) => lo !== undefined || hi !== undefined)
      .map(([lo, hi]): FilterInput => {
        const [a, b] = lo !== undefined && hi !== undefined && hi < lo ? [hi, lo] : [lo, hi];
        return {
          kind: 'range',
          column: column.name,
          ...(a === undefined ? {} : { min: a * width }),
          ...(b === undefined ? {} : { max: b * width }),
          minInclusive: true,
          maxInclusive: false,
        };
      });
    return fc
      .option(fc.oneof({ arbitrary: range, weight: 5 }, { arbitrary: nullTests(column), weight: 1 }), { nil: null, freq: 8 })
      .map((selection) => ({ dimension, selection }));
  });
}

/** A brush on a time axis: bounds are bucket starts of values in the table (or around it), in any spelling. */
function timeBrush(table: TestTable, column: TestColumn): fc.Arbitrary<Brush> {
  const units: TimeUnit[] = column.type === 'timestamp' ? ['hour', 'day', 'month'] : ['day', 'month'];
  const index = table.columns.indexOf(column);
  const values = table.rows.map((row) => row[index]).filter((v): v is number => typeof v === 'number');
  const anchor = values.length > 0 ? fc.constantFrom(...values) : fc.constant(Date.UTC(2023, 10, 15));
  return fc.constantFrom(...units).chain((unit) => {
    const dimension: CrossfilterDimension = { column: column.name, bin: { kind: 'time', unit } };
    const bound = fc
      .tuple(anchor, fc.integer({ min: -3, max: 3 }))
      .map(([ms, shift]) => truncateTime(ms + shift * 86_400_000 * (unit === 'month' ? 31 : 1), unit))
      .chain((ms) => fc.constantFrom<number | string>(ms, column.type === 'date' ? isoDate(ms) : isoTimestamp(ms)));
    const optional = fc.option(bound, { nil: undefined, freq: 5 });
    const range = fc
      .tuple(optional, optional)
      .filter(([lo, hi]) => lo !== undefined || hi !== undefined)
      .map(([lo, hi]): FilterInput => ({
        kind: 'range',
        column: column.name,
        ...(lo === undefined ? {} : { min: lo }),
        ...(hi === undefined ? {} : { max: hi }),
        minInclusive: true,
        maxInclusive: false,
      }));
    return fc
      .option(fc.oneof({ arbitrary: range, weight: 5 }, { arbitrary: nullTests(column), weight: 1 }), { nil: null, freq: 8 })
      .map((selection) => ({ dimension, selection }));
  });
}

/** A value dimension (bar clicks, the grid): any filter on the column. */
function valueBrush(table: TestTable, column: TestColumn): fc.Arbitrary<Brush> {
  const dimension: CrossfilterDimension = { column: column.name, bin: { kind: 'value' } };
  const single: TestTable = { columns: table.columns, rows: table.rows };
  const filter = filterArb(single).filter((candidate) => candidate.column === column.name);
  return fc.option(filter, { nil: null, freq: 8 }).map((selection) => ({ dimension, selection }));
}

function brushArb(table: TestTable): fc.Arbitrary<Brush> {
  return fc.constantFrom(...table.columns).chain((column) => {
    if (isNumeric(column)) return fc.oneof({ arbitrary: widthBrush(column), weight: 3 }, valueBrush(table, column));
    if (isTemporal(column)) return fc.oneof({ arbitrary: timeBrush(table, column), weight: 3 }, valueBrush(table, column));
    return valueBrush(table, column);
  });
}

function chartArb(table: TestTable): fc.Arbitrary<{ spec: ChartSpecInput; pixelWidth: number }> {
  const plain = (arb: fc.Arbitrary<ChartSpecInput>) => arb.map((spec) => ({ spec, pixelWidth: 1000 }));
  return fc.oneof(plain(barSpecArb(table)), plain(histogramSpecArb(table)), plain(heatmapSpecArb(table)), lineSpecArb(table));
}

function close(a: Cell, b: Cell): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b || Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  return Object.is(a, b);
}

function describeFailure(queries: Record<string, CompiledQuery>, actual: unknown, expected: unknown): string {
  return [
    ...Object.entries(queries).flatMap(([name, query]) => [`${name}:`, query.sql, `params: ${JSON.stringify(query.params)}`]),
    `actual:   ${JSON.stringify(actual)}`,
    `expected: ${JSON.stringify(expected)}`,
  ].join('\n');
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

async function buildCube(build: CompiledQuery): Promise<void> {
  await connection.run(`CREATE OR REPLACE TABLE ${CUBE} AS ${build.sql}`, build.params as DuckDBValue[]);
}

describe('cross-filter cube property tests (cube answer vs plain SQL)', () => {
  it('every brush aligned to the dimension is answerable', () => {
    fc.assert(
      fc.property(
        tableArb.chain((table) => brushArb(table)),
        ({ dimension, selection }) => selection === null || cubeSelection(FilterSchema.parse(selection), dimension) !== null,
      ),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('charts (bar, histogram, heatmap, line/area) answered from a cube equal the plain query with the brush', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb.chain((table) => fc.tuple(fc.constant(table), chartArb(table), brushArb(table))),
        async ([table, { spec, pixelWidth }, { dimension, selection }]) => {
          await loadTable(connection, table);
          const profile = profileOf(table);
          const build = compileChartCubeBuild(TABLE, spec, profile, dimension, { pixelWidth });
          await buildCube(build);
          const answer = compileChartCubeAnswer(CUBE, spec, profile, dimension, selection, { pixelWidth });
          const plain = compileChartQuery(
            TABLE,
            { ...spec, filters: [...(spec.filters ?? []), ...(selection ? [selection] : [])] },
            profile,
            { pixelWidth },
          );
          const actual = await runQuery(connection, answer);
          const expected = await runQuery(connection, plain);
          if (!sameRows(actual, expected)) expect.fail(describeFailure({ build, answer, plain }, actual, expected));
        },
      ),
      RUN,
    );
  }, TIMEOUT_MS);

  it('the count cube counts the rows the base filters and the brush select', async () => {
    await fc.assert(
      fc.asyncProperty(
        tableArb.chain((table) => fc.tuple(fc.constant(table), filtersArb(table), brushArb(table))),
        async ([table, filters, { dimension, selection }]) => {
          await loadTable(connection, table);
          const profile = profileOf(table);
          const build = compileCountCubeBuild(TABLE, filters, profile, dimension);
          await buildCube(build);
          const answer = compileCountCubeAnswer(CUBE, profile, dimension, selection);
          const [row] = await runQuery(connection, answer);
          const expected = refCount(table, [...filters, ...(selection ? [selection] : [])]);
          if (row?.['row_count'] !== expected) expect.fail(describeFailure({ build, answer }, row, expected));
        },
      ),
      RUN,
    );
  }, TIMEOUT_MS);

  it('bins agree with brush bounds where floor(v / w) is off by one (1.7 / 0.1 < 17 but 1.7 >= 17 * 0.1)', async () => {
    const values = [1.7, 3.4, 3.9, 4.3, 6.8, -4.2, -3.6, 0.3, 0.7, 1.6, 1.8, 16.5];
    const table: TestTable = { columns: [{ name: 'v', type: 'decimal' }], rows: values.map((v) => [v]) };
    await loadTable(connection, table);
    const profile = profileOf(table);
    for (const width of [0.1, 0.3, 1.1]) {
      const dimension: CrossfilterDimension = { column: 'v', bin: { kind: 'width', width } };
      const build = compileCountCubeBuild(TABLE, [], profile, dimension);
      await buildCube(build);
      for (const value of values) {
        const k = Math.round(value / width);
        for (const [lo, hi] of [
          [k, k + 1],
          [k - 1, k],
          [k + 1, k + 2],
          [k - 2, k + 2],
        ] as const) {
          const selection: FilterInput = { kind: 'range', column: 'v', min: lo * width, max: hi * width, minInclusive: true, maxInclusive: false };
          const [row] = await runQuery(connection, compileCountCubeAnswer(CUBE, profile, dimension, selection));
          expect(row?.['row_count'], `width ${width}, bins [${lo}, ${hi})`).toBe(refCount(table, [selection]));
        }
      }
    }
  });

  it('equal filter sets in any order build the same cube', () => {
    fc.assert(
      fc.property(
        tableArb.chain((table) => fc.tuple(fc.constant(table), barSpecArb(table), brushArb(table))),
        ([table, spec, { dimension }]) => {
          const profile = profileOf(table);
          const a = compileChartCubeBuild(TABLE, spec, profile, dimension);
          const b = compileChartCubeBuild(TABLE, { ...spec, filters: [...(spec.filters ?? [])].reverse() }, profile, dimension);
          expect(b).toEqual(a);
        },
      ),
      { seed: SEED, numRuns: 100 },
    );
  });
});

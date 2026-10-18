import fc from 'fast-check';
import { type ChartSpecInput, type ColumnType, type FilterInput, type RowQueryInput, type TimeUnit } from '../../src/index.js';
import { ALL_TYPES, isoDate, isoTimestamp, type Cell, type TestColumn, type TestTable } from './model.js';

/** Column names chosen to break naive SQL generation: quotes, spaces, unicode, keywords, internal aliases. */
const NAME_POOL = [
  'id',
  'select',
  'Order',
  'a b',
  'quo"te',
  "it's",
  'ünïcödé',
  '日付',
  '1st',
  'x',
  'y',
  'gx',
  'gy',
  'gc',
  'color',
  'count',
  '__gg_base',
  'from',
  'NULL',
  '😀 emoji',
  'tab\there',
  'semi;colon',
  '--dash',
  '"',
  'v',
  'k',
  'other',
  'px',
  'GROUP',
  'table',
];

const TEXT_POOL = ['', 'a', 'A', 'b', 'é', 'é', '日本', '😀', "O'Brien", 'x"y', ' lead', 'Other', 'NULL', 'z', '�', ''];

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const BASE = Date.UTC(2023, 10, 15);

/** Spacing between generated temporal values; with up to 60 steps this spans hours to years. */
const DATE_STEPS = [DAY, 30 * DAY];
const TIMESTAMP_STEPS = [7 * MINUTE, 5 * HOUR, DAY + HOUR, 9 * DAY, 30 * DAY];

interface ColumnPlan extends TestColumn {
  readonly step: number;
}

function valueArb(column: ColumnPlan): fc.Arbitrary<Exclude<Cell, null>> {
  switch (column.type) {
    case 'integer':
      return fc.integer({ min: -6, max: 6 });
    case 'float':
      return fc.integer({ min: -80, max: 80 }).map((k) => k / 8);
    case 'decimal':
      return fc.integer({ min: -500, max: 500 }).map((cents) => cents / 100);
    case 'boolean':
      return fc.boolean();
    case 'date':
    case 'timestamp':
      return fc.integer({ min: 0, max: 60 }).map((k) => BASE + k * column.step);
    case 'text':
      return fc.constantFrom(...TEXT_POOL);
  }
}

function cellArb(column: ColumnPlan): fc.Arbitrary<Cell> {
  return fc.option(valueArb(column), { nil: null, freq: 6 });
}

const MAX_ROWS = 60;

/** A table with every column type at least once, odd names, NULLs and duplicates; 0 to 60 rows. */
export const tableArb: fc.Arbitrary<TestTable> = fc
  .tuple(
    fc.uniqueArray(fc.constantFrom(...NAME_POOL), {
      minLength: ALL_TYPES.length,
      maxLength: ALL_TYPES.length + 2,
      // DuckDB identifiers are case-insensitive even when quoted.
      selector: (name) => name.toLowerCase(),
    }),
    fc.shuffledSubarray([...ALL_TYPES], { minLength: ALL_TYPES.length, maxLength: ALL_TYPES.length }),
    fc.array(fc.constantFrom(...ALL_TYPES), { minLength: 2, maxLength: 2 }),
    fc.array(fc.nat(), { minLength: ALL_TYPES.length + 2, maxLength: ALL_TYPES.length + 2 }),
  )
  .chain(([names, types, extra, stepSeeds]) => {
    const allTypes = [...types, ...extra];
    const columns: ColumnPlan[] = names.map((name, i) => {
      const type = allTypes[i] ?? 'text';
      const steps = type === 'date' ? DATE_STEPS : TIMESTAMP_STEPS;
      return { name, type, step: steps[(stepSeeds[i] ?? 0) % steps.length] ?? DAY };
    });
    // Uniform row counts: fast-check's default size would keep most tables tiny,
    // and ties at top-N / top-8 / M4 boundaries need a few dozen rows.
    return fc
      .nat({ max: MAX_ROWS })
      .chain((n) => fc.array(fc.tuple(...columns.map(cellArb)), { minLength: n, maxLength: n }))
      .map((rows): TestTable => ({ columns: columns.map(({ name, type }) => ({ name, type })), rows }));
  });

/* ---------------------------------------------------------------- helpers */

const isNumeric = (type: ColumnType) => type === 'integer' || type === 'float' || type === 'decimal';
const isTemporal = (type: ColumnType) => type === 'date' || type === 'timestamp';
const isPositional = (type: ColumnType) => isNumeric(type) || isTemporal(type);

function columnsWhere(table: TestTable, predicate: (type: ColumnType) => boolean): TestColumn[] {
  return table.columns.filter((c) => predicate(c.type));
}

function pick(columns: readonly TestColumn[]): fc.Arbitrary<TestColumn> {
  return fc.constantFrom(...columns);
}

function existing(table: TestTable, column: TestColumn): Exclude<Cell, null>[] {
  const index = table.columns.indexOf(column);
  return table.rows.map((row) => row[index] ?? null).filter((v): v is Exclude<Cell, null> => v !== null);
}

/** A value of the column's domain: an existing value (to hit equality) or a fresh one, including off-grid numbers. */
function domainValue(table: TestTable, column: TestColumn): fc.Arbitrary<Exclude<Cell, null>> {
  const fresh: fc.Arbitrary<Exclude<Cell, null>> = (() => {
    switch (column.type) {
      case 'integer':
        return fc.oneof(fc.integer({ min: -7, max: 7 }), fc.integer({ min: -14, max: 14 }).map((k) => k / 2));
      case 'float':
        return fc.oneof(fc.integer({ min: -90, max: 90 }).map((k) => k / 8), fc.integer({ min: -90, max: 90 }).map((k) => k / 16));
      case 'decimal':
        return fc.oneof(fc.integer({ min: -520, max: 520 }).map((c) => c / 100), fc.integer({ min: -5200, max: 5200 }).map((m) => m / 1000));
      case 'boolean':
        return fc.boolean();
      case 'date':
      case 'timestamp':
        return fc.integer({ min: -2, max: 1900 }).map((k) => BASE + k * DAY + (column.type === 'timestamp' ? (k % 24) * HOUR : 0));
      case 'text':
        return fc.constantFrom(...TEXT_POOL, 'not present');
    }
  })();
  const values = existing(table, column);
  return values.length > 0 ? fc.oneof(fc.constantFrom(...values), fresh) : fresh;
}

/** Temporal bounds in every accepted spelling. */
function temporalSpelling(ms: number): fc.Arbitrary<number | string> {
  return fc.constantFrom(ms, isoDate(ms), isoTimestamp(ms), new Date(ms).toISOString(), isoTimestamp(ms).replace(' ', 'T'));
}

function boundArb(table: TestTable, column: TestColumn): fc.Arbitrary<number | string> {
  return domainValue(table, column).chain((v) => (isTemporal(column.type) ? temporalSpelling(Number(v)) : fc.constant(Number(v))));
}

function setValueArb(table: TestTable, column: TestColumn): fc.Arbitrary<string | number | boolean | null> {
  const value = domainValue(table, column).chain((v) =>
    isTemporal(column.type) ? temporalSpelling(Number(v)) : fc.constant(v),
  );
  return fc.option(value, { nil: null, freq: 5 });
}

export function filterArb(table: TestTable): fc.Arbitrary<FilterInput> {
  return pick(table.columns).chain((column): fc.Arbitrary<FilterInput> => {
    const nullFilters = fc.constantFrom<FilterInput>(
      { kind: 'isNull', column: column.name },
      { kind: 'notNull', column: column.name },
    );
    const inFilter = fc
      .tuple(fc.constantFrom('in' as const, 'in' as const, 'notIn' as const), fc.array(setValueArb(table, column), { maxLength: 4 }))
      .map(([kind, values]): FilterInput => ({ kind, column: column.name, values }));
    if (!isPositional(column.type)) return fc.oneof({ arbitrary: inFilter, weight: 3 }, { arbitrary: nullFilters, weight: 1 });
    const bound = fc.option(boundArb(table, column), { nil: undefined, freq: 3 });
    const inclusive = fc.option(fc.boolean(), { nil: undefined, freq: 3 });
    const range = fc
      .record({ min: bound, max: bound, minInclusive: inclusive, maxInclusive: inclusive })
      .filter((r) => r.min !== undefined || r.max !== undefined)
      .map((r): FilterInput => {
        const filter: Extract<FilterInput, { kind: 'range' }> = { kind: 'range', column: column.name };
        if (r.min !== undefined) filter.min = r.min;
        if (r.max !== undefined) filter.max = r.max;
        if (r.minInclusive !== undefined) filter.minInclusive = r.minInclusive;
        if (r.maxInclusive !== undefined) filter.maxInclusive = r.maxInclusive;
        return filter;
      });
    return fc.oneof({ arbitrary: range, weight: 4 }, { arbitrary: inFilter, weight: 2 }, { arbitrary: nullFilters, weight: 1 });
  });
}

export function filtersArb(table: TestTable): fc.Arbitrary<FilterInput[]> {
  return fc.array(filterArb(table), { maxLength: 3 });
}

/* ------------------------------------------------------------- row query */

export function rowQueryArb(table: TestTable): fc.Arbitrary<RowQueryInput> {
  const sortKey = fc.record({
    column: pick(table.columns).map((c) => c.name),
    direction: fc.constantFrom<'asc' | 'desc'>('asc', 'desc'),
  });
  return fc.record({
    offset: fc.integer({ min: 0, max: 45 }),
    limit: fc.integer({ min: 1, max: 30 }),
    sort: fc.array(sortKey, { maxLength: 3 }),
    filters: filtersArb(table),
  });
}

/* ------------------------------------------------------------ chart specs */

type YInput = NonNullable<ChartSpecInput['y']>;
type FieldInput = ChartSpecInput['x'];

/** An optional measure: count of anything, sum/avg/min/max of numbers, min/max of dates. */
function measureArb(table: TestTable): fc.Arbitrary<YInput | undefined> {
  const any = pick(table.columns).map((c): YInput => ({ column: c.name, aggregate: 'count' }));
  const numeric = fc
    .tuple(pick(columnsWhere(table, isNumeric)), fc.constantFrom('sum', 'avg', 'min', 'max' as const))
    .map(([c, aggregate]): YInput => ({ column: c.name, aggregate }));
  const temporal = fc
    .tuple(pick(columnsWhere(table, isTemporal)), fc.constantFrom('min', 'max' as const))
    .map(([c, aggregate]): YInput => ({ column: c.name, aggregate }));
  return fc.option(fc.oneof(any, { arbitrary: numeric, weight: 3 }, temporal), { nil: undefined, freq: 3 });
}

function colorArb(table: TestTable): fc.Arbitrary<{ column: string } | undefined> {
  return fc.option(
    pick(table.columns).map((c) => ({ column: c.name })),
    { nil: undefined, freq: 2 },
  );
}

function timeUnitArb(column: TestColumn): fc.Arbitrary<TimeUnit> {
  return column.type === 'timestamp' ? fc.constantFrom('hour', 'day', 'month') : fc.constantFrom('day', 'month');
}

/** x (or heatmap y) for binned marks: numeric with no/auto/explicit width, or temporal with no/explicit unit. */
function binnedFieldArb(table: TestTable, widths: readonly number[]): fc.Arbitrary<FieldInput> {
  return pick(columnsWhere(table, isPositional)).chain((column): fc.Arbitrary<FieldInput> => {
    if (isTemporal(column.type)) {
      return fc.record({
        column: fc.constant(column.name),
        timeUnit: fc.option(timeUnitArb(column), { nil: undefined }),
        bin: fc.option(fc.constant('auto' as const), { nil: undefined }),
      });
    }
    return fc.record({
      column: fc.constant(column.name),
      bin: fc.option(fc.oneof(fc.constant('auto' as const), fc.constantFrom(...widths)), { nil: undefined }),
    });
  });
}

function clean<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export function barSpecArb(table: TestTable): fc.Arbitrary<ChartSpecInput> {
  const x = pick(table.columns).chain(
    (column): fc.Arbitrary<FieldInput> =>
      isTemporal(column.type)
      ? fc.record({ column: fc.constant(column.name), timeUnit: fc.option(timeUnitArb(column), { nil: undefined }) })
      : fc.constant({ column: column.name }),
  );
  return fc
    .record({
      x,
      y: measureArb(table),
      color: colorArb(table),
      filters: filtersArb(table),
      limit: fc.option(fc.integer({ min: 1, max: 12 }), { nil: undefined }),
      other: fc.option(fc.boolean(), { nil: undefined }),
    })
    .map((spec) => clean({ mark: 'bar' as const, ...spec, x: clean(spec.x) }));
}

export function histogramSpecArb(table: TestTable): fc.Arbitrary<ChartSpecInput> {
  return fc
    .record({
      x: binnedFieldArb(table, [0.25, 0.5, 1, 2.5, 3, 7]),
      y: measureArb(table),
      color: colorArb(table),
      filters: filtersArb(table),
    })
    .map((spec) => clean({ mark: 'histogram' as const, ...spec, x: clean(spec.x) }));
}

export function heatmapSpecArb(table: TestTable): fc.Arbitrary<ChartSpecInput> {
  return fc
    .record({
      x: binnedFieldArb(table, [0.5, 1, 2, 5]),
      y: binnedFieldArb(table, [0.25, 1, 3]),
      aggregate: fc.option(fc.constant('count' as const), { nil: undefined }),
      filters: filtersArb(table),
    })
    .map(({ x, y, aggregate, filters }) =>
      clean({ mark: 'heatmap' as const, x: clean(x), y: clean({ ...y, aggregate }), filters }),
    );
}

export function lineSpecArb(table: TestTable): fc.Arbitrary<{ spec: ChartSpecInput; pixelWidth: number }> {
  const x = pick(columnsWhere(table, isPositional)).chain((column): fc.Arbitrary<FieldInput> => {
    if (isTemporal(column.type)) {
      return fc.record({
        column: fc.constant(column.name),
        timeUnit: fc.option(timeUnitArb(column), { nil: undefined }),
      });
    }
    return fc.record({
      column: fc.constant(column.name),
      bin: fc.option(fc.oneof(fc.constant('auto' as const), fc.constantFrom(0.5, 1, 3)), { nil: undefined, freq: 2 }),
    });
  });
  return fc.record({
    spec: fc
      .record({
        mark: fc.constantFrom('line' as const, 'area' as const),
        x,
        y: measureArb(table),
        color: colorArb(table),
        filters: filtersArb(table),
      })
      .map((spec) => clean({ ...spec, x: clean(spec.x) })),
    // Tiny widths force several points into each pixel column so M4 has work to do.
    pixelWidth: fc.constantFrom(1, 2, 3, 5, 8, 13, 40, 1000),
  });
}

export function scatterSpecArb(table: TestTable): fc.Arbitrary<ChartSpecInput> {
  const positional = pick(columnsWhere(table, isPositional)).map((c) => ({ column: c.name }));
  return fc
    .record({
      x: positional,
      y: positional,
      color: colorArb(table),
      filters: filtersArb(table),
      limit: fc.option(fc.integer({ min: 1, max: 30 }), { nil: undefined, freq: 3 }),
    })
    .map((spec) => clean({ mark: 'scatter' as const, ...spec }));
}

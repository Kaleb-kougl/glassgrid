import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AggregateSchema,
  COLUMN_TYPES,
  digestPersisted,
  isWorkspaceDirty,
  MarkSchema,
  parseWorkspace,
  persistedDigest,
  persistedWorkspace,
  restoreWorkspace,
  serializeWorkspace,
  TimeUnitSchema,
  WorkspaceStateSchema,
  type ColumnType,
  type FilterInput,
  type WorkspaceState,
} from '../src/index.js';
import { must } from '../src/workspace-file/test-support.js';

/*
 * Random valid workspaces: serialize → parse gives back exactly the
 * persisted subset (and drops the ephemeral fields), parse → serialize is
 * stable, and restoring over the same data gives back the state minus its
 * ephemeral fields, clean and without warnings.
 */

const NAMES = ['id', 'a b', 'quo"te', "it's", 'ünïcödé', '日付', '😀', 'select', '__gg', 'tab\there', 'x', 'y'];

const text = fc.string({ unit: 'binary', maxLength: 8 });
const number = fc.double({ noNaN: true, noDefaultInfinity: true }).map((value) => (Object.is(value, -0) ? 0 : value));
const scalar = fc.oneof(text, number, fc.boolean(), fc.constant(null));
const id = (prefix: string, i: number) => `${prefix}_${i}`;

function filterArb(columns: readonly string[]): fc.Arbitrary<FilterInput> {
  const column = fc.constantFrom(...columns);
  const bound = fc.oneof(number, fc.string({ minLength: 1, maxLength: 12 }));
  return fc.oneof(
    fc
      .record({ column, min: fc.option(bound, { nil: undefined }), max: fc.option(bound, { nil: undefined }), minInclusive: fc.boolean(), maxInclusive: fc.boolean() })
      .filter((f) => f.min !== undefined || f.max !== undefined)
      .map(({ min, max, ...rest }) => ({ kind: 'range' as const, ...rest, ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) })),
    fc.record({ kind: fc.constantFrom('in' as const, 'notIn' as const), column, values: fc.array(scalar, { maxLength: 4 }) }),
    fc.record({ kind: fc.constantFrom('isNull' as const, 'notNull' as const), column }),
  );
}

function fieldArb(columns: readonly string[]) {
  return fc
    .record({
      column: fc.constantFrom(...columns),
      bin: fc.option(fc.oneof(fc.constant('auto' as const), fc.integer({ min: 1, max: 1000 })), { nil: undefined }),
      timeUnit: fc.option(fc.constantFrom(...TimeUnitSchema.options), { nil: undefined }),
    })
    .map(({ column, bin, timeUnit }) => ({ column, ...(bin === undefined ? {} : { bin }), ...(timeUnit === undefined ? {} : { timeUnit }) }));
}

const stateArb: fc.Arbitrary<WorkspaceState> = fc
  .uniqueArray(fc.oneof(fc.constantFrom(...NAMES), fc.string({ minLength: 1, maxLength: 6 })), { minLength: 1, maxLength: 6 })
  .chain((names) =>
    fc.record({
      names: fc.constant(names),
      types: fc.array(fc.constantFrom(...COLUMN_TYPES), { minLength: names.length, maxLength: names.length }),
      overrides: fc.array(fc.option(fc.constantFrom(...COLUMN_TYPES), { nil: null }), { minLength: names.length, maxLength: names.length }),
      profiled: fc.array(fc.boolean(), { minLength: names.length, maxLength: names.length }),
      charts: fc.array(
        fc.record({
          mark: fc.constantFrom(...MarkSchema.options),
          x: fieldArb(names),
          y: fc.option(fc.tuple(fieldArb(names), fc.option(fc.constantFrom(...AggregateSchema.options), { nil: undefined })), { nil: undefined }),
          color: fc.option(fieldArb(names), { nil: undefined }),
          filters: fc.array(filterArb(names), { maxLength: 2 }),
          limit: fc.option(fc.integer({ min: 1, max: 1000 }), { nil: undefined }),
          other: fc.option(fc.boolean(), { nil: undefined }),
          title: fc.option(fc.string({ minLength: 1, maxLength: 20 }).map((t) => t.trim()).filter((t) => t.length > 0), { nil: undefined }),
          card: fc.record({ x: fc.nat(6), y: fc.nat(20), w: fc.integer({ min: 1, max: 4 }), h: fc.integer({ min: 1, max: 4 }) }),
        }),
        { maxLength: 4 },
      ),
      selected: fc.array(fc.boolean(), { minLength: 5, maxLength: 5 }),
      clauses: fc.array(
        fc.record({
          source: fc.constantFrom('brush' as const, 'click' as const, 'filter' as const),
          clauses: fc.array(fc.record({ channel: fc.constantFrom('x' as const, 'y' as const, null), filter: filterArb(names) }), { minLength: 1, maxLength: 2 }),
        }),
        { minLength: 5, maxLength: 5 },
      ),
      userFilters: fc.array(filterArb(names), { maxLength: 3 }),
      sort: fc.uniqueArray(fc.record({ column: fc.constantFrom(...names), direction: fc.constantFrom('asc' as const, 'desc' as const) }), {
        selector: (key) => key.column,
        maxLength: 3,
      }),
      order: fc.shuffledSubarray(names),
      widths: fc.uniqueArray(fc.record({ column: fc.constantFrom(...names), width: fc.integer({ min: 48, max: 2000 }) }), { selector: (w) => w.column }),
      cell: fc.option(fc.record({ row: fc.nat(), column: fc.constantFrom(...names) }), { nil: null }),
      document: fc.option(fc.record({ fileName: fc.constantFrom('a.glassgrid', 'trips.glassgrid') }), { nil: undefined }),
    }),
  )
  .map((plan) => {
    const columns = plan.names.map((name, i) => {
      const inferredType = plan.types[i] as ColumnType;
      const override = plan.overrides[i] ?? null;
      return {
        name,
        inferredType,
        typeOverride: override === inferredType ? null : override,
        ...(plan.profiled[i] ? { profile: { type: inferredType, distinctCount: 3, nullFraction: 0.25, min: 0, max: 9 } } : {}),
      };
    });
    const charts = plan.charts.map((chart, i) => ({
      id: id('chart', i + 1),
      spec: {
        mark: chart.mark,
        x: chart.x,
        ...(chart.y === undefined ? {} : { y: { ...chart.y[0], ...(chart.y[1] === undefined ? {} : { aggregate: chart.y[1] }) } }),
        ...(chart.color === undefined ? {} : { color: chart.color }),
        filters: chart.filters,
        ...(chart.limit === undefined ? {} : { limit: chart.limit }),
        ...(chart.other === undefined ? {} : { other: chart.other }),
      },
      ...(chart.title === undefined ? {} : { title: chart.title }),
    }));
    const views = [...charts.map((chart) => chart.id), 'grid'];
    const selections: Record<string, unknown> = {};
    views.forEach((view, i) => {
      if (plan.selected[i]) selections[view] = plan.clauses[i];
    });
    const state = {
      dataSource: { handleId: 'fh_0123456789abcdef', fileName: 'data.csv', fingerprint: { sizeBytes: 1, mtimeMs: 2, headTailSha256: 'e'.repeat(64), key: 'f'.repeat(32) } },
      columns,
      charts,
      selections,
      userFilters: plan.userFilters.map((filter, i) => ({ id: id('filter', i + 1), filter })),
      grid: { sort: plan.sort, columnOrder: plan.order, columnWidths: plan.widths, selection: plan.cell === null ? null : { anchor: plan.cell, focus: plan.cell } },
      layout: { cards: plan.charts.map((chart, i) => ({ chartId: id('chart', i + 1), ...chart.card })) },
      ...(plan.document === undefined ? {} : { document: { id: 'doc_12345678', fileName: plan.document.fileName, savedDigest: '0123456789abcdef' } }),
    };
    // Canonical: what the store would hold (schema defaults applied).
    return WorkspaceStateSchema.parse(state);
  });

const META = { app: { name: 'Glassgrid', version: '1.0.0' }, savedAt: '2026-10-18T00:00:00.000Z', absolutePath: '/d/data.csv', relativePath: 'data.csv' };

/** The state without what is not saved: profiles, the grid selection, the document. */
function withoutEphemeral(state: WorkspaceState): WorkspaceState {
  const { document: _document, ...rest } = state;
  return {
    ...rest,
    columns: state.columns.map(({ profile: _profile, ...column }) => column),
    grid: { ...state.grid, selection: null },
  };
}

describe('workspace file (property)', () => {
  it('serialize → parse returns exactly the persisted subset, without ephemeral fields', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const text = serializeWorkspace(state, META);
        const parsed = parseWorkspace(text);
        expect(parsed.workspace).toEqual(persistedWorkspace(state));
        expect(digestPersisted(parsed.workspace)).toBe(persistedDigest(state));
        expect(parsed.workspace.columns.some((column) => 'profile' in column)).toBe(false);
        expect('selection' in parsed.workspace.grid).toBe(false);
        expect(text).not.toContain('"handleId"');
        expect(text).not.toContain('"document"');
        // Stable: saving what was opened writes the same bytes.
        expect(serializeWorkspace({ dataSource: must(state.dataSource), workspace: parsed.workspace }, META)).toBe(text);
      }),
      { numRuns: 300 },
    );
  });

  it('restoring over the same data gives back the state minus ephemeral fields, clean, with no warnings', () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const parsed = parseWorkspace(serializeWorkspace(state, META));
        const source = must(state.dataSource);
        const data = {
          handleId: source.handleId,
          fileName: source.fileName,
          fingerprint: source.fingerprint,
          columns: state.columns.map((column) => ({ name: column.name, type: column.inferredType })),
        };
        const document = { id: 'doc_87654321', fileName: 'w.glassgrid', savedDigest: digestPersisted(parsed.workspace) };
        const { state: restored, warnings } = restoreWorkspace(parsed.workspace, data, document);
        expect(warnings).toEqual([]);
        expect(withoutEphemeral(restored)).toEqual(withoutEphemeral(state));
        expect(restored.document).toEqual(document);
        expect(isWorkspaceDirty(restored)).toBe(false);
        expect(WorkspaceStateSchema.parse(restored)).toEqual(restored);
      }),
      { numRuns: 300 },
    );
  });
});

import { describe, expect, it } from 'vitest';
import { CommandError } from '../commands/errors.js';
import { openFileInput, testWorkspace } from '../commands/test-support.js';
import { type ChartSpec } from '../spec/chart.js';
import { type ColumnType } from '../spec/column.js';
import { cubeSelection } from '../sql/align.js';
import { compileChartQuery } from '../sql/chart.js';
import { type WorkspaceState } from '../state/workspace.js';
import { stateColumns } from './axes.js';
import { binIndex, brushRangeFilter, formatTemporal } from './brush.js';
import { binStart } from '../sql/bins.js';
import { filterChips, filterCondition, filterLabel } from './chips.js';
import { defaultChartSpec } from './defaults.js';
import { changedSelectionView, crossfilterPlan, effectiveFilters, engineViewId, viewQueries } from './model.js';

/** A taxi-like file with profiles recorded, as the app has it a moment after open. */
const COLUMNS: { name: string; type: ColumnType; distinctCount: number; min: number | string | boolean | null; max: number | string | boolean | null }[] = [
  { name: 'pickup_datetime', type: 'timestamp', distinctCount: 9_000_000, min: '2024-03-01 00:00:00', max: '2024-05-30 23:59:59' },
  { name: 'trip_date', type: 'date', distinctCount: 91, min: '2024-03-01', max: '2024-05-30' },
  { name: 'trip_distance', type: 'float', distinctCount: 4_000, min: 0, max: 60 },
  { name: 'fare_amount', type: 'decimal', distinctCount: 20_000, min: 3, max: 250 },
  { name: 'passenger_count', type: 'integer', distinctCount: 6, min: 1, max: 6 },
  { name: 'payment_type', type: 'text', distinctCount: 5, min: 'Cash', max: 'Unknown' },
  { name: 'zone', type: 'text', distinctCount: 265, min: 'Astoria', max: 'Yorkville' },
  { name: 'airport', type: 'boolean', distinctCount: 2, min: false, max: true },
  { name: 'notes', type: 'text', distinctCount: 0, min: null, max: null },
];

async function taxi(options: { profiles?: boolean } = {}) {
  const workspace = testWorkspace();
  const { registry } = workspace;
  await registry.dispatch('openFile', openFileInput({ columns: COLUMNS.map(({ name, type }) => ({ name, type })) }), { caller: 'user' });
  if (options.profiles !== false) {
    await registry.dispatch(
      'setColumnProfiles',
      { columns: COLUMNS.map((column) => ({ ...column, nullFraction: 0 })) },
      { caller: 'user' },
    );
  }
  const add = async (input: unknown) => {
    const { state } = await registry.dispatch('addChart', input, { caller: 'user' });
    return state.charts.at(-1)?.id ?? '';
  };
  return { ...workspace, add };
}

function specOf(state: WorkspaceState, chartId: string): ChartSpec {
  const chart = state.charts.find((candidate) => candidate.id === chartId);
  if (!chart) throw new Error(`no chart ${chartId}`);
  return chart.spec;
}

describe('default chart rules', () => {
  const cases: { columns: string[]; spec: Omit<ChartSpec, 'filters'> }[] = [
    { columns: ['pickup_datetime'], spec: { mark: 'line', x: { column: 'pickup_datetime' } } },
    { columns: ['trip_date'], spec: { mark: 'line', x: { column: 'trip_date' } } },
    { columns: ['payment_type'], spec: { mark: 'bar', x: { column: 'payment_type' }, limit: 50 } },
    { columns: ['airport'], spec: { mark: 'bar', x: { column: 'airport' }, limit: 50 } },
    { columns: ['zone'], spec: { mark: 'bar', x: { column: 'zone' }, limit: 20, other: true } },
    { columns: ['trip_distance'], spec: { mark: 'histogram', x: { column: 'trip_distance', bin: 'auto' } } },
    { columns: ['passenger_count'], spec: { mark: 'histogram', x: { column: 'passenger_count', bin: 'auto' } } },
    {
      columns: ['trip_distance', 'fare_amount'],
      spec: { mark: 'heatmap', x: { column: 'trip_distance', bin: 'auto' }, y: { column: 'fare_amount', bin: 'auto' } },
    },
    {
      columns: ['pickup_datetime', 'trip_date'],
      spec: { mark: 'heatmap', x: { column: 'pickup_datetime', bin: 'auto' }, y: { column: 'trip_date', bin: 'auto' } },
    },
    {
      columns: ['pickup_datetime', 'fare_amount'],
      spec: { mark: 'line', x: { column: 'pickup_datetime' }, y: { column: 'fare_amount', aggregate: 'sum' } },
    },
    {
      columns: ['fare_amount', 'pickup_datetime'],
      spec: { mark: 'line', x: { column: 'pickup_datetime' }, y: { column: 'fare_amount', aggregate: 'sum' } },
    },
    {
      columns: ['pickup_datetime', 'payment_type'],
      spec: { mark: 'line', x: { column: 'pickup_datetime' }, color: { column: 'payment_type' } },
    },
    {
      columns: ['payment_type', 'fare_amount'],
      spec: { mark: 'bar', x: { column: 'payment_type' }, y: { column: 'fare_amount', aggregate: 'sum' }, limit: 50 },
    },
    {
      columns: ['zone', 'fare_amount'],
      spec: { mark: 'bar', x: { column: 'zone' }, y: { column: 'fare_amount', aggregate: 'sum' }, limit: 20, other: true },
    },
    {
      columns: ['payment_type', 'airport'],
      spec: { mark: 'bar', x: { column: 'payment_type' }, color: { column: 'airport' }, limit: 50 },
    },
    {
      columns: ['trip_distance', 'payment_type'],
      spec: { mark: 'histogram', x: { column: 'trip_distance', bin: 'auto' }, color: { column: 'payment_type' } },
    },
  ];

  it.each(cases)('$columns → $spec.mark', async ({ columns, spec }) => {
    const { add, store } = await taxi();
    const id = await add({ columns });
    expect(specOf(store.getState(), id)).toEqual({ ...spec, filters: [] });
    // Every default compiles against the columns it was made for.
    expect(() => compileChartQuery('"t"', specOf(store.getState(), id), stateColumns(store.getState()))).not.toThrow();
  });

  it('without a profile, a category gets the top 20 plus Other', async () => {
    const { add, store } = await taxi({ profiles: false });
    const id = await add({ columns: ['payment_type'] });
    expect(specOf(store.getState(), id)).toMatchObject({ mark: 'bar', limit: 20, other: true });
  });

  it('a stale profile (type changed since) is ignored', async () => {
    const { add, store, registry } = await taxi();
    await registry.dispatch('setColumnType', { column: 'passenger_count', type: 'text' }, { caller: 'user' });
    const id = await add({ columns: ['passenger_count'] });
    expect(specOf(store.getState(), id)).toMatchObject({ mark: 'bar', limit: 20, other: true });
  });

  it('defaultChartSpec is pure and rejects nothing it is given', () => {
    const columns = stateColumns({ columns: [] });
    expect(columns).toEqual([]);
    expect(defaultChartSpec({ name: 'n', type: 'integer' })).toEqual({ mark: 'histogram', x: { column: 'n', bin: 'auto' }, filters: [] });
  });

  it('addChart from columns checks the columns and keeps the title', async () => {
    const { add, registry, store } = await taxi();
    const id = await add({ columns: ['payment_type'], title: 'Payments' });
    expect(store.getState().charts.at(-1)).toMatchObject({ id, title: 'Payments' });
    await expect(registry.dispatch('addChart', { columns: ['nope'] }, { caller: 'ai' })).rejects.toMatchObject({
      code: 'precondition_failed',
      issues: [{ path: 'columns[0]' }],
    });
    await expect(registry.dispatch('addChart', { columns: [] }, { caller: 'ai' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(registry.dispatch('addChart', { columns: ['a', 'b', 'c'] }, { caller: 'ai' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('setColumnProfiles', () => {
  it('records profiles without an undo entry and ignores unknown columns', async () => {
    const { registry, store } = await taxi({ profiles: false });
    const before = store.getHistory().past.length;
    const { entryId } = await registry.dispatch(
      'setColumnProfiles',
      { columns: [{ name: 'trip_distance', type: 'float', distinctCount: 9, nullFraction: 0.25, min: 0, max: 8 }, { name: 'ghost', type: 'text', distinctCount: 1, nullFraction: 0, min: 'a', max: 'a' }] },
      { caller: 'user' },
    );
    expect(entryId).toBeNull();
    expect(store.getHistory().past.length).toBe(before);
    expect(store.getState().columns.find((column) => column.name === 'trip_distance')?.profile).toEqual({
      type: 'float',
      distinctCount: 9,
      nullFraction: 0.25,
      min: 0,
      max: 8,
    });
    expect(JSON.parse(JSON.stringify(store.getState()))).toEqual(store.getState());
  });

  it('is not available to AI callers', async () => {
    const { registry } = await taxi({ profiles: false });
    await expect(registry.dispatch('setColumnProfiles', { columns: [] }, { caller: 'ai' })).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('brush', () => {
  it('snaps a histogram brush outwards to bin edges as [lo, hi)', async () => {
    const { add, registry, store } = await taxi();
    const id = await add({ columns: ['trip_distance'] }); // 0..60 → width 2 (nice width for 50 bins)
    await registry.dispatch('brush', { viewId: id, selection: { type: 'interval', x: { min: 2.7, max: 5.1 } } }, { caller: 'user' });
    expect(store.getState().selections[id]).toEqual({
      source: 'brush',
      clauses: [{ channel: 'x', filter: { kind: 'range', column: 'trip_distance', min: 2, max: 6, minInclusive: true, maxInclusive: false } }],
    });
    expect(filterChips(store.getState()).map((chip) => chip.label)).toEqual(['trip_distance 2.00 – 6.00']);

    // Reversed ends, exact edges and a brush inside one bin.
    await registry.dispatch('brush', { viewId: id, selection: { type: 'interval', x: { min: 8, max: 4 } } }, { caller: 'user' });
    expect(store.getState().selections[id]?.clauses[0]?.filter).toMatchObject({ min: 4, max: 8 });
    await registry.dispatch('brush', { viewId: id, selection: { type: 'interval', x: { min: 4.2, max: 4.3 } } }, { caller: 'user' });
    expect(store.getState().selections[id]?.clauses[0]?.filter).toMatchObject({ min: 4, max: 6 });
    await registry.dispatch('brush', { viewId: id, selection: { type: 'interval', x: { min: 10 } } }, { caller: 'user' });
    expect(store.getState().selections[id]?.clauses[0]?.filter).toEqual({ kind: 'range', column: 'trip_distance', min: 10, minInclusive: true, maxInclusive: false });
  });

  it('snaps to bin starts that select exactly what the histogram draws, also where k * w rounds across an edge', () => {
    expect(binIndex(1.7, 0.1)).toBe(17); // floor(1.7 / 0.1) = 17 ...
    expect(17 * 0.1).toBe(1.7000000000000002); // ... but 1.7 < 17 * 0.1,
    expect(binStart(17, 0.1)).toBe(1.7); // so bin 17 starts at 1.7.
    expect(binIndex(4.3, 0.1)).toBe(42); // 4.3 / 0.1 = 42.99999999999999 ...
    expect(binStart(43, 0.1)).toBe(4.300000000000001); // ... so bin 43 starts just above 4.3.
    expect(binStart(3, 2)).toBe(6);
    expect(binIndex(-0.05, 0.1)).toBe(-1);
    const filter = brushRangeFilter({ kind: 'width', column: { name: 'v', type: 'float' }, width: 0.1 }, { min: 1.72, max: 4.3 }, 'x');
    expect(filter).toMatchObject({ min: 1.7, max: 4.300000000000001 });
  });

  it('snaps time brushes to buckets and writes them as DuckDB text', async () => {
    const { add, registry, store } = await taxi();
    const id = await add({ spec: { mark: 'histogram', x: { column: 'pickup_datetime', timeUnit: 'day' } } });
    await registry.dispatch(
      'brush',
      { viewId: id, selection: { type: 'interval', x: { min: '2024-03-03 10:15:00', max: Date.UTC(2024, 2, 5, 1) } } },
      { caller: 'user' },
    );
    expect(store.getState().selections[id]?.clauses[0]?.filter).toEqual({
      kind: 'range',
      column: 'pickup_datetime',
      min: '2024-03-03 00:00:00',
      max: '2024-03-06 00:00:00',
      minInclusive: true,
      maxInclusive: false,
    });
    expect(filterChips(store.getState())[0]?.label).toBe('pickup_datetime 2024-03-03 – 2024-03-06');

    const monthly = await add({ spec: { mark: 'line', x: { column: 'trip_date', timeUnit: 'month' } } });
    await registry.dispatch('brush', { viewId: monthly, selection: { type: 'interval', x: { min: '2024-03-20', max: '2024-04-01' } } }, { caller: 'user' });
    expect(store.getState().selections[monthly]?.clauses[0]?.filter).toMatchObject({ min: '2024-03-01', max: '2024-04-01' });
  });

  it('makes two ranges for a 2-D brush, inclusive on raw scatter axes', async () => {
    const { add, registry, store } = await taxi();
    const heat = await add({ columns: ['trip_distance', 'fare_amount'] });
    await registry.dispatch(
      'brush',
      { viewId: heat, selection: { type: 'interval', x: { min: 1, max: 3 }, y: { min: 10, max: 12 } } },
      { caller: 'user' },
    );
    const clauses = store.getState().selections[heat]?.clauses ?? [];
    expect(clauses.map((clause) => [clause.channel, clause.filter.column])).toEqual([
      ['x', 'trip_distance'],
      ['y', 'fare_amount'],
    ]);
    // Heatmap axes aim at 100 bins: width 1 for 0..60 (already aligned), width 5 for 3..250.
    expect(clauses[0]?.filter).toMatchObject({ min: 1, max: 3, maxInclusive: false });
    expect(clauses[1]?.filter).toMatchObject({ min: 10, max: 15, maxInclusive: false });
    const scatter = await add({ spec: { mark: 'scatter', x: { column: 'trip_distance' }, y: { column: 'fare_amount' } } });
    await registry.dispatch('brush', { viewId: scatter, selection: { type: 'interval', x: { min: 1.234, max: 3.5 } } }, { caller: 'user' });
    expect(store.getState().selections[scatter]?.clauses[0]?.filter).toEqual({
      kind: 'range',
      column: 'trip_distance',
      min: 1.234,
      max: 3.5,
      minInclusive: true,
      maxInclusive: true,
    });
  });

  it('turns bar clicks into in / notIn filters and a time bucket click into its range', async () => {
    const { add, registry, store } = await taxi();
    const payments = await add({ columns: ['payment_type'] });
    await registry.dispatch('brush', { viewId: payments, selection: { type: 'points', values: ['Cash'] } }, { caller: 'user' });
    expect(store.getState().selections[payments]).toEqual({
      source: 'click',
      clauses: [{ channel: 'x', filter: { kind: 'in', column: 'payment_type', values: ['Cash'] } }],
    });
    expect(filterChips(store.getState())[0]?.label).toBe('payment_type = Cash');

    const zones = await add({ columns: ['zone'] });
    await registry.dispatch(
      'brush',
      { viewId: zones, selection: { type: 'points', values: ['Astoria'], other: { shown: ['Astoria', 'Midtown', 'SoHo'] } } },
      { caller: 'user' },
    );
    expect(store.getState().selections[zones]?.clauses[0]?.filter).toEqual({ kind: 'notIn', column: 'zone', values: ['Midtown', 'SoHo'] });
    expect(filterChips(store.getState())[1]?.label).toBe('zone not in Midtown, SoHo');

    const daily = await add({ spec: { mark: 'bar', x: { column: 'trip_date', timeUnit: 'day' } } });
    await registry.dispatch('brush', { viewId: daily, selection: { type: 'points', values: ['2024-03-05'] } }, { caller: 'user' });
    expect(store.getState().selections[daily]?.clauses[0]?.filter).toMatchObject({ min: '2024-03-05', max: '2024-03-06', maxInclusive: false });
  });

  it('rejects gestures the view cannot make, with the path and a fix', async () => {
    const { add, registry } = await taxi();
    const histogram = await add({ columns: ['trip_distance'] });
    const bar = await add({ columns: ['payment_type'] });
    const fail = (viewId: string, selection: unknown) => registry.dispatch('brush', { viewId, selection }, { caller: 'ai' });
    await expect(fail(histogram, { type: 'points', values: [1] })).rejects.toThrow('brush a range on this histogram chart');
    await expect(fail(histogram, { type: 'interval', y: { min: 1 } })).rejects.toMatchObject({ issues: [{ path: 'selection.y' }] });
    await expect(fail(histogram, { type: 'interval', x: { min: 'a lot' } })).rejects.toMatchObject({ issues: [{ path: 'selection.x.min' }] });
    await expect(fail(bar, { type: 'interval', x: { min: 1 } })).rejects.toThrow('Bar charts select values');
    await expect(fail(bar, { type: 'points', values: [7] })).rejects.toMatchObject({ code: 'precondition_failed', issues: [{ path: 'selection' }] });
    await expect(fail('chart_404', null)).rejects.toThrow('Unknown view "chart_404"');
    await expect(fail('grid', { type: 'points', values: ['Cash'] })).rejects.toThrow('set selection.column');
    await expect(fail(bar, { type: 'points', values: [] })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('selects in the grid by column; the grid does not filter itself', async () => {
    const { add, registry, store } = await taxi();
    const bar = await add({ columns: ['payment_type'] });
    await registry.dispatch('brush', { viewId: 'grid', selection: { type: 'points', column: 'zone', values: ['SoHo'] } }, { caller: 'user' });
    await registry.dispatch('brush', { viewId: 'grid', selection: { type: 'interval', column: 'fare_amount', x: { min: 20, max: 10 } } }, { caller: 'user' });
    expect(store.getState().selections['grid']?.clauses).toEqual([
      { channel: null, filter: { kind: 'range', column: 'fare_amount', min: 10, max: 20, minInclusive: true, maxInclusive: true } },
    ]);
    expect(effectiveFilters(store.getState(), 'grid')).toEqual([]);
    expect(effectiveFilters(store.getState(), bar)).toHaveLength(1);
  });

  it('is one undo entry per commit; null clears', async () => {
    const { add, registry, store } = await taxi();
    const id = await add({ columns: ['trip_distance'] });
    const before = store.getHistory().past.length;
    await registry.dispatch('brush', { viewId: id, selection: { type: 'interval', x: { min: 1, max: 3 } } }, { caller: 'user' });
    await registry.dispatch('brush', { viewId: id, selection: { type: 'interval', x: { min: 5, max: 7 } } }, { caller: 'user' });
    expect(store.getHistory().past.length).toBe(before + 2);
    await registry.dispatch('brush', { viewId: id, selection: null }, { caller: 'user' });
    expect(store.getState().selections).toEqual({});
    await registry.dispatch('undo', {}, { caller: 'user' });
    expect(store.getState().selections[id]?.clauses[0]?.filter).toMatchObject({ min: 4, max: 8 });
    const { entryId } = await registry.dispatch('brush', { viewId: 'grid', selection: null }, { caller: 'user' });
    expect(entryId).toBeNull();
  });
});

describe('filter composition', () => {
  it('each view queries with every selection but its own, plus every user filter', async () => {
    const { add, registry, store } = await taxi();
    const distance = await add({ columns: ['trip_distance'] });
    const payments = await add({ columns: ['payment_type'] });
    const time = await add({ columns: ['pickup_datetime'] });
    await registry.dispatch('addFilter', { filter: { kind: 'notNull', column: 'fare_amount' } }, { caller: 'user' });
    await registry.dispatch('brush', { viewId: distance, selection: { type: 'interval', x: { min: 2, max: 6 } } }, { caller: 'user' });
    await registry.dispatch('brush', { viewId: payments, selection: { type: 'points', values: ['Cash'] } }, { caller: 'user' });

    const state = store.getState();
    const range = state.selections[distance]?.clauses[0]?.filter;
    const cash = state.selections[payments]?.clauses[0]?.filter;
    const notNull = state.userFilters[0]?.filter;
    const queries = viewQueries(state, { activeView: distance });
    expect(queries.grid.filters).toEqual([notNull, range, cash]);
    const byId = new Map(queries.charts.map((query) => [query.chartId, query]));
    expect(byId.get(distance)?.spec.filters).toEqual([notNull, cash]);
    expect(byId.get(payments)?.spec.filters).toEqual([notNull, range]);
    expect(byId.get(time)?.spec.filters).toEqual([notNull, range, cash]);
    expect(byId.get(time)?.engineViewId).toBe(`chart:${time}`);
    expect(engineViewId('grid')).toBe('grid');

    // Hints point at the active brush's filter in each other view's request.
    expect(byId.get(distance)?.crossfilter).toBeNull();
    expect(byId.get(payments)?.crossfilter).toEqual({ filter: 1, dimension: { column: 'trip_distance', bin: { kind: 'width', width: 2 } } });
    expect(byId.get(time)?.crossfilter?.filter).toBe(1);
    expect(queries.grid.crossfilter).toEqual({ filter: 1, dimension: { column: 'trip_distance', bin: { kind: 'width', width: 2 } } });
    // The active brush is aligned to its dimension, so a cube can answer it.
    expect(cubeSelection(range ?? { kind: 'isNull', column: 'x' }, { column: 'trip_distance', bin: { kind: 'width', width: 2 } })).not.toBeNull();

    // Keys move with the inputs, not with the hint.
    const again = viewQueries(state);
    expect(again.charts.map((query) => query.key)).toEqual(queries.charts.map((query) => query.key));
    expect(again.charts[1]?.crossfilter).toBeNull();
  });

  it('plans the cubes for a brush start without the brushed view\'s own selection', async () => {
    const { add, registry, store } = await taxi();
    const distance = await add({ columns: ['trip_distance'] });
    const payments = await add({ columns: ['payment_type'] });
    await add({ spec: { mark: 'scatter', x: { column: 'trip_distance' }, y: { column: 'fare_amount' } } });
    await registry.dispatch('brush', { viewId: distance, selection: { type: 'interval', x: { min: 2, max: 6 } } }, { caller: 'user' });
    await registry.dispatch('brush', { viewId: payments, selection: { type: 'points', values: ['Cash'] } }, { caller: 'user' });
    const plan = crossfilterPlan(store.getState(), distance);
    expect(plan?.dimension).toEqual({ column: 'trip_distance', bin: { kind: 'width', width: 2 } });
    expect(plan?.targets.map((target) => [target.kind, target.viewId])).toEqual([
      ['aggregate', payments],
      ['count', 'grid'],
    ]);
    const cash = store.getState().selections[payments]?.clauses[0]?.filter;
    expect(plan?.targets[0]).toMatchObject({ kind: 'aggregate', spec: { filters: [] } });
    expect(plan?.targets[1]).toMatchObject({ kind: 'count', filters: [cash] });
    expect(crossfilterPlan(store.getState(), payments, 'y')).toBeNull();
  });

  it('names the view whose selection changed', async () => {
    const { add, registry, store } = await taxi();
    const id = await add({ columns: ['trip_distance'] });
    const before = store.getState();
    await registry.dispatch('brush', { viewId: id, selection: { type: 'interval', x: { min: 2, max: 6 } } }, { caller: 'user' });
    expect(changedSelectionView(before, store.getState())).toBe(id);
    expect(changedSelectionView(store.getState(), store.getState())).toBeNull();
  });
});

describe('filter chips', () => {
  it('labels filters by column type', () => {
    expect(filterLabel({ kind: 'range', column: 'trip_distance', min: 2, max: 6, minInclusive: true, maxInclusive: false }, 'float')).toBe(
      'trip_distance 2.00 – 6.00',
    );
    expect(filterLabel({ kind: 'in', column: 'payment_type', values: ['Cash'] }, 'text')).toBe('payment_type = Cash');
    expect(filterCondition({ kind: 'range', column: 'n', min: 1234.5, minInclusive: true, maxInclusive: true }, 'decimal')).toBe('≥ 1,234.50');
    expect(filterCondition({ kind: 'range', column: 'n', max: 10, minInclusive: true, maxInclusive: false }, 'integer')).toBe('< 10');
    expect(filterCondition({ kind: 'range', column: 'n', min: 0.125, max: 2, minInclusive: true, maxInclusive: false }, 'float')).toBe('0.125 – 2.000');
    expect(filterCondition({ kind: 'in', column: 'c', values: ['a', null, 'b'] }, 'text')).toBe('in a, null, b');
    expect(filterCondition({ kind: 'in', column: 'c', values: [1, 2, 3, 4, 5] }, 'integer')).toBe('in 5 values');
    expect(filterCondition({ kind: 'in', column: 'c', values: [] }, 'text')).toBe('matches nothing');
    expect(filterCondition({ kind: 'notIn', column: 'c', values: ['a'] }, 'text')).toBe('≠ a');
    expect(filterCondition({ kind: 'notIn', column: 'c', values: [] }, 'text')).toBe('any value');
    expect(filterCondition({ kind: 'isNull', column: 'c' })).toBe('is null');
    expect(filterCondition({ kind: 'notNull', column: 'c' })).toBe('is not null');
    expect(
      filterCondition({ kind: 'range', column: 't', min: '2024-03-01 06:30:00', max: Date.UTC(2024, 2, 2), minInclusive: true, maxInclusive: false }, 'timestamp'),
    ).toBe('2024-03-01 06:30 – 2024-03-02');
    expect(filterCondition({ kind: 'in', column: 't', values: ['2024-03-01 06:30:15'] }, 'timestamp')).toBe('= 2024-03-01 06:30:15');
    expect(formatTemporal(Date.UTC(2024, 0, 2, 3, 4, 5, 6), 'timestamp')).toBe('2024-01-02 03:04:05.006');
  });

  it('removing a chip clears its brush; on a 2-D brush only that axis', async () => {
    const { add, registry, store } = await taxi();
    const heat = await add({ columns: ['trip_distance', 'fare_amount'] });
    const bar = await add({ columns: ['payment_type'] });
    await registry.dispatch('addFilter', { filter: { kind: 'range', column: 'passenger_count', min: 2, minInclusive: true, maxInclusive: true } }, { caller: 'user' });
    await registry.dispatch('brush', { viewId: heat, selection: { type: 'interval', x: { min: 1, max: 3 }, y: { min: 10, max: 12 } } }, { caller: 'user' });
    await registry.dispatch('brush', { viewId: bar, selection: { type: 'points', values: ['Cash', 'Dispute'] } }, { caller: 'user' });
    const chips = filterChips(store.getState());
    expect(chips.map((chip) => chip.label)).toEqual([
      'passenger_count ≥ 2',
      'trip_distance 1.00 – 3.00',
      'fare_amount 10.00 – 15.00',
      'payment_type in Cash, Dispute',
    ]);
    expect(new Set(chips.map((chip) => chip.id)).size).toBe(chips.length);

    const fare = chips[2];
    if (!fare) throw new Error('no chip');
    await registry.dispatch(fare.remove.command, fare.remove.input, { caller: 'user' });
    expect(store.getState().selections[heat]?.clauses.map((clause) => clause.filter.column)).toEqual(['trip_distance']);
    for (const chip of filterChips(store.getState())) await registry.dispatch(chip.remove.command, chip.remove.input, { caller: 'user' });
    expect(store.getState()).toMatchObject({ selections: {}, userFilters: [] });
    expect(filterChips(store.getState())).toEqual([]);
  });

  it('clearFilter with an unknown filter id or column records nothing', async () => {
    const { add, registry, store } = await taxi();
    const id = await add({ columns: ['trip_distance'] });
    await registry.dispatch('brush', { viewId: id, selection: { type: 'interval', x: { min: 1, max: 3 } } }, { caller: 'user' });
    expect((await registry.dispatch('clearFilter', { filterId: 'filter_9' }, { caller: 'ai' })).entryId).toBeNull();
    expect((await registry.dispatch('clearFilter', { viewId: id, column: 'zone' }, { caller: 'ai' })).entryId).toBeNull();
    expect(store.getState().selections[id]).toBeDefined();
    await expect(registry.dispatch('clearFilter', { viewId: id, filterId: 'x' }, { caller: 'ai' })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('addFilter validates the filter against the column type', async () => {
    const { registry } = await taxi();
    await expect(registry.dispatch('addFilter', { filter: { kind: 'in', column: 'trip_distance', values: ['far'] } }, { caller: 'ai' })).rejects.toThrow(
      'must be a number',
    );
    await expect(registry.dispatch('addFilter', { filter: { kind: 'range', column: 'zone', min: 1 } }, { caller: 'ai' })).rejects.toThrow(
      'Range filters need a numeric, date or timestamp column',
    );
    const error: unknown = await registry.dispatch('addFilter', { filter: { kind: 'isNull', column: 'nope' } }, { caller: 'ai' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
  });
});

describe('setMark', () => {
  it('re-derives shelves and validates with the compiler', async () => {
    const { add, registry, store } = await taxi();
    const id = await add({ columns: ['trip_distance', 'fare_amount'] }); // heatmap
    const set = (mark: string) => registry.dispatch('setMark', { chartId: id, mark }, { caller: 'ai' });
    await set('scatter');
    expect(specOf(store.getState(), id)).toEqual({ mark: 'scatter', x: { column: 'trip_distance' }, y: { column: 'fare_amount' }, filters: [] });
    await set('histogram');
    expect(specOf(store.getState(), id)).toEqual({ mark: 'histogram', x: { column: 'trip_distance', bin: 'auto' }, filters: [] });
    await registry.dispatch('setShelf', { chartId: id, shelf: 'y', field: { column: 'fare_amount', aggregate: 'avg' } }, { caller: 'ai' });
    await set('line');
    expect(specOf(store.getState(), id)).toEqual({
      mark: 'line',
      x: { column: 'trip_distance', bin: 'auto' },
      y: { column: 'fare_amount', aggregate: 'avg' },
      filters: [],
    });
    await set('heatmap');
    expect(specOf(store.getState(), id)).toEqual({
      mark: 'heatmap',
      x: { column: 'trip_distance', bin: 'auto' },
      y: { column: 'fare_amount', bin: 'auto' },
      filters: [],
    });
    await set('bar');
    expect(specOf(store.getState(), id)).toEqual({ mark: 'bar', x: { column: 'trip_distance' }, filters: [] });
    expect((await set('bar')).entryId).toBeNull();
  });

  it('refuses marks the columns cannot make and clears a selection the new mark could not have made', async () => {
    const { add, registry, store } = await taxi();
    const payments = await add({ columns: ['payment_type'] });
    await expect(registry.dispatch('setMark', { chartId: payments, mark: 'histogram' }, { caller: 'ai' })).rejects.toThrow(
      'histogram charts need a numeric, date or timestamp column on x',
    );
    await expect(registry.dispatch('setMark', { chartId: payments, mark: 'heatmap' }, { caller: 'ai' })).rejects.toMatchObject({
      issues: [{ path: 'y' }],
    });
    await registry.dispatch('setShelf', { chartId: payments, shelf: 'y', field: { column: 'zone', aggregate: 'count' } }, { caller: 'ai' });
    await expect(registry.dispatch('setMark', { chartId: payments, mark: 'scatter' }, { caller: 'ai' })).rejects.toThrow('"payment_type" is text');

    const distance = await add({ spec: { mark: 'bar', x: { column: 'passenger_count' } } });
    await registry.dispatch('brush', { viewId: distance, selection: { type: 'points', values: [2] } }, { caller: 'user' });
    await registry.dispatch('setMark', { chartId: distance, mark: 'line' }, { caller: 'user' });
    expect(store.getState().selections[distance]).toBeUndefined();
    await registry.dispatch('undo', {}, { caller: 'user' });
    expect(specOf(store.getState(), distance).mark).toBe('bar');
    expect(store.getState().selections[distance]).toBeDefined();

    const histogram = await add({ columns: ['trip_distance'] });
    await registry.dispatch('brush', { viewId: histogram, selection: { type: 'interval', x: { min: 2, max: 4 } } }, { caller: 'user' });
    await registry.dispatch('setMark', { chartId: histogram, mark: 'area' }, { caller: 'user' });
    // A range on x still fits an area chart over the same column.
    expect(store.getState().selections[histogram]).toBeDefined();
  });
});

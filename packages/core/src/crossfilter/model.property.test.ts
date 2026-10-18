import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createWorkspace } from '../commands/all.js';
import { fakeClock, sequentialIds } from '../commands/test-support.js';
import { type ChartSpec } from '../spec/chart.js';
import { type Filter } from '../spec/filter.js';
import { type TimeUnit } from '../spec/field.js';
import { cubeSelection } from '../sql/align.js';
import { parseTemporal, truncateTime, addTime } from '../sql/bins.js';
import {
  createInitialWorkspaceState,
  GRID_VIEW_ID,
  WorkspaceStateSchema,
  type Selection,
  type WorkspaceState,
} from '../state/workspace.js';
import { brushRangeFilter } from './brush.js';
import { filterChips } from './chips.js';
import { effectiveFilters, selectionOrder, viewQueries } from './model.js';

const SEED = 20261018;

const COLUMNS = ['a', 'b', 'c', 'd'] as const;

/**
 * Every generated filter is unique (its `min` is a fresh serial number), so
 * a filter in a query can be traced back to the selection or user filter it
 * came from.
 */
function stateArb(): fc.Arbitrary<WorkspaceState> {
  return fc
    .record({
      charts: fc.integer({ min: 0, max: 4 }),
      ownFilters: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 4, maxLength: 4 }),
      selected: fc.array(fc.option(fc.integer({ min: 1, max: 2 }), { nil: null }), { minLength: 5, maxLength: 5 }),
      sources: fc.array(fc.constantFrom('brush' as const, 'click' as const, 'filter' as const), { minLength: 5, maxLength: 5 }),
      userFilters: fc.integer({ min: 0, max: 3 }),
      columns: fc.array(fc.constantFrom(...COLUMNS), { minLength: 40, maxLength: 40 }),
    })
    .map(({ charts, ownFilters, selected, sources, userFilters, columns }) => {
      let serial = 0;
      const unique = (): Filter => {
        serial += 1;
        return { kind: 'range', column: columns[serial % columns.length] ?? 'a', min: serial, minInclusive: true, maxInclusive: true };
      };
      const state = createInitialWorkspaceState();
      state.columns = COLUMNS.map((name) => ({ name, inferredType: 'float', typeOverride: null }));
      for (let i = 0; i < charts; i += 1) {
        const spec: ChartSpec = { mark: 'histogram', x: { column: COLUMNS[i] ?? 'a' }, filters: Array.from({ length: ownFilters[i] ?? 0 }, unique) };
        state.charts.push({ id: `chart_${i + 1}`, spec });
      }
      const views = [...state.charts.map((chart) => chart.id), GRID_VIEW_ID];
      views.forEach((viewId, i) => {
        const picked = selected[i];
        if (picked === null || picked === undefined) return;
        // The grid selects on one column at a time; charts brush one or two axes.
        const clauses = viewId === GRID_VIEW_ID ? 1 : picked;
        const selection: Selection = {
          source: sources[i] ?? 'brush',
          clauses: Array.from({ length: clauses }, (_, index) => ({ channel: viewId === GRID_VIEW_ID ? null : index === 0 ? ('x' as const) : ('y' as const), filter: unique() })),
        };
        state.selections[viewId] = selection;
      });
      state.userFilters = Array.from({ length: userFilters }, (_, i) => ({ id: `filter_${i + 1}`, filter: unique() }));
      return WorkspaceStateSchema.parse(state);
    });
}

const key = (filter: Filter) => JSON.stringify(filter);

describe('cross-filter model (property)', () => {
  it('a view never queries with its own selection, and with every other selection and user filter exactly once', () => {
    fc.assert(
      fc.property(stateArb(), (state) => {
        const views = [...state.charts.map((chart) => chart.id), GRID_VIEW_ID];
        const users = state.userFilters.map((entry) => entry.filter);
        for (const viewId of views) {
          const filters = effectiveFilters(state, viewId);
          const own = new Set((state.selections[viewId]?.clauses ?? []).map((clause) => key(clause.filter)));
          expect(filters.some((filter) => own.has(key(filter)))).toBe(false);
          const expected = [
            ...users,
            ...selectionOrder(state)
              .filter((owner) => owner !== viewId)
              .flatMap((owner) => (state.selections[owner]?.clauses ?? []).map((clause) => clause.filter)),
          ];
          expect(filters).toEqual(expected);
          expect(new Set(filters.map(key)).size).toBe(filters.length);
        }
        // Charts query with their own spec filters first; nothing from their own selection.
        const queries = viewQueries(state);
        expect(queries.grid.filters).toEqual(effectiveFilters(state, GRID_VIEW_ID));
        for (const query of queries.charts) {
          const chart = state.charts.find((candidate) => candidate.id === query.chartId);
          expect(query.spec.filters).toEqual([...(chart?.spec.filters ?? []), ...effectiveFilters(state, query.chartId)]);
        }
      }),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('cross-filter hints point at the active view\'s selection in every other view\'s request', () => {
    fc.assert(
      fc.property(
        stateArb().chain((state) => fc.tuple(fc.constant(state), fc.constantFrom(...[...state.charts.map((c) => c.id), GRID_VIEW_ID]))),
        ([state, activeView]) => {
          const queries = viewQueries(state, { activeView });
          const active = state.selections[activeView];
          const all = [
            { viewId: GRID_VIEW_ID, filters: queries.grid.filters, hint: queries.grid.crossfilter },
            ...queries.charts.map((query) => ({ viewId: query.chartId, filters: query.spec.filters, hint: query.crossfilter })),
          ];
          for (const view of all) {
            if (view.viewId === activeView || !active || active.clauses.length !== 1) {
              expect(view.hint).toBeNull();
              continue;
            }
            const hint = view.hint;
            if (hint === null) continue; // e.g. the active chart's axis does not resolve
            expect(view.filters[hint.filter]).toEqual(active.clauses[0]?.filter);
          }
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
  });

  it('chips list every filter once, and removing any chip removes exactly that filter', async () => {
    await fc.assert(
      fc.asyncProperty(
        stateArb().chain((state) => fc.tuple(fc.constant(state), fc.nat())),
        async ([state, pickSeed]) => {
          const { registry, store } = createWorkspace({ clock: fakeClock(), newId: sequentialIds(), initialState: state });
          const chips = filterChips(store.getState());
          const everything = [
            ...state.userFilters.map((entry) => entry.filter),
            ...selectionOrder(state).flatMap((owner) => (state.selections[owner]?.clauses ?? []).map((clause) => clause.filter)),
          ];
          expect(chips.map((chip) => chip.filter)).toEqual(everything);
          expect(new Set(chips.map((chip) => chip.id)).size).toBe(chips.length);
          if (chips.length === 0) return;

          const chip = chips[pickSeed % chips.length];
          if (!chip) return;
          await registry.dispatch(chip.remove.command, chip.remove.input, { caller: 'user' });
          const after = filterChips(store.getState()).map((candidate) => key(candidate.filter));
          // Removing a selection chip clears that view's selection, except one axis of a 2-D brush.
          const removed = new Set([key(chip.filter)]);
          if (chip.viewId !== null && (state.selections[chip.viewId]?.clauses.length ?? 0) === 1) {
            for (const clause of state.selections[chip.viewId]?.clauses ?? []) removed.add(key(clause.filter));
          }
          expect(after).toEqual(everything.map(key).filter((candidate) => !removed.has(candidate)));
          // And undo brings it back.
          await registry.dispatch('undo', {}, { caller: 'user' });
          expect(filterChips(store.getState()).map((candidate) => candidate.filter)).toEqual(everything);
        },
      ),
      { seed: SEED, numRuns: 200 },
    );
  });

  it('numeric brushes snap outwards to the fewest whole bins, aligned for cubes', () => {
    const column = { name: 'v', type: 'float' as const };
    fc.assert(
      fc.property(
        fc.constantFrom(0.1, 0.25, 0.3, 1, 1.1, 2, 5, 0.05),
        fc.double({ min: -500, max: 500, noNaN: true }),
        fc.double({ min: -500, max: 500, noNaN: true }),
        (width, a, b) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          const filter = brushRangeFilter({ kind: 'width', column, width }, { min: a, max: b }, 'x');
          if (filter.kind !== 'range' || typeof filter.min !== 'number' || typeof filter.max !== 'number') throw new Error('expected a numeric range');
          expect(filter).toMatchObject({ minInclusive: true, maxInclusive: false });
          // Contains the brushed values, as the engine compares them.
          expect(filter.min <= lo).toBe(true);
          expect(hi < filter.max || hi === filter.max).toBe(true);
          // Tight: dropping the first or last bin would lose brushed values.
          const kMin = Math.round(filter.min / width);
          const kMax = Math.round(filter.max / width);
          expect(kMin * width).toBe(filter.min);
          expect(kMax * width).toBe(filter.max);
          expect(kMax > kMin).toBe(true);
          if (kMax - kMin > 1) {
            expect(lo < (kMin + 1) * width).toBe(true);
            expect(hi > (kMax - 1) * width).toBe(true);
          }
          expect(cubeSelection(filter, { column: 'v', bin: { kind: 'width', width } })).toEqual({ kind: 'bins', min: kMin, max: kMax });
        },
      ),
      { seed: SEED, numRuns: 2000 },
    );
  });

  it('time brushes snap outwards to whole buckets, aligned for cubes', () => {
    const DAY = 86_400_000;
    fc.assert(
      fc.property(
        fc.constantFrom<TimeUnit>('hour', 'day', 'month'),
        fc.constantFrom('date' as const, 'timestamp' as const),
        fc.integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 0, 1) }),
        fc.integer({ min: 0, max: 400 * DAY }),
        (unit, type, start, length) => {
          if (type === 'date' && unit === 'hour') return;
          const column = { name: 't', type };
          const lo = type === 'date' ? Math.floor(start / DAY) * DAY : start;
          const hi = type === 'date' ? Math.floor((start + length) / DAY) * DAY : start + length;
          const filter = brushRangeFilter({ kind: 'time', column, unit }, { min: lo, max: hi }, 'x');
          if (filter.kind !== 'range' || filter.min === undefined || filter.max === undefined) throw new Error('expected a range');
          const min = parseTemporal(filter.min);
          const max = parseTemporal(filter.max);
          if (min === null || max === null) throw new Error(`unparseable ${JSON.stringify(filter)}`);
          expect(truncateTime(min, unit)).toBe(min);
          expect(truncateTime(max, unit)).toBe(max);
          expect(min <= lo && hi <= max).toBe(true);
          expect(addTime(min, unit) > lo).toBe(true);
          expect(max > min).toBe(true);
          expect(cubeSelection(filter, { column: 't', bin: { kind: 'time', unit } })).toEqual({ kind: 'filter' });
        },
      ),
      { seed: SEED, numRuns: 1000 },
    );
  });
});

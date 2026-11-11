import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { filterChips } from '../crossfilter/chips.js';
import { mapViewportFilters, roundBounds, viewportCondition } from '../crossfilter/map-selection.js';
import { crossfilterPlan, effectiveFilters, viewQueries } from '../crossfilter/model.js';
import { playedToEnd, resolveTime, TIME_FOLLOW_WINDOW_MS, timeCursor, timeWindowFilter } from '../crossfilter/time.js';
import { stateColumns } from '../crossfilter/axes.js';
import { LIVE_FLIGHTS_FINGERPRINT, LIVE_FLIGHTS_HANDLE, LIVE_FLIGHTS_TABLE_NAME } from '../flights/table.js';
import { compileChartQuery } from '../sql/chart.js';
import { compileMapLatestQuery } from '../sql/map.js';
import { compileWhere } from '../sql/where.js';
import { DEFAULT_TIME_CURSOR, type MapViewState, type WorkspaceState } from '../state/workspace.js';
import { persistedDigest, persistedWorkspace } from '../workspace-file/persisted.js';
import { MCP_EXEMPTIONS } from './mcp-exemptions.js';
import { openFileInput, testWorkspace } from './test-support.js';

/*
 * Milestone L4 (docs/live-flights-l4.md) in core: a map's viewport as its
 * selection (filters, exclusion from its own view, chips), the commands
 * that set it and turn it on and off (undo, no history per pan, MCP), and
 * the time cursor (setTime, setChartsFollowTime, resolving T, the charts'
 * window).
 */

const user = { caller: 'user' as const };
const ai = { caller: 'ai' as const };

const FLIGHT_COLUMNS = [
  { name: 'ts', type: 'timestamp' },
  { name: 'hex', type: 'text' },
  { name: 'flight', type: 'text' },
  { name: 'lat', type: 'decimal' },
  { name: 'lon', type: 'decimal' },
  { name: 'altBaroFt', type: 'integer' },
  { name: 'baroRateFpm', type: 'integer' },
  { name: 'category', type: 'text' },
] as const;

const BOX = { west: -122.6123456, south: 37.4000001, east: -122.0000009, north: 37.9 };

async function flightsWorkspace() {
  const workspace = testWorkspace();
  const { registry } = workspace;
  await registry.dispatch(
    'openFile',
    openFileInput({ handleId: LIVE_FLIGHTS_HANDLE, fileName: LIVE_FLIGHTS_TABLE_NAME, fingerprint: { ...LIVE_FLIGHTS_FINGERPRINT }, columns: FLIGHT_COLUMNS.map((c) => ({ ...c })) }),
    user,
  );
  await registry.dispatch('addChart', { spec: { mark: 'histogram', x: { column: 'altBaroFt', bin: 1000 } } }, user);
  await registry.dispatch('addChart', { spec: { mark: 'bar', x: { column: 'category' } } }, user);
  await registry.dispatch('addMapView', { title: 'Bay Area traffic' }, user);
  return workspace;
}

const mapOf = (state: WorkspaceState): MapViewState => {
  const map = state.maps[0];
  if (!map) throw new Error('no map');
  return map;
};

describe('a map viewport as a selection', () => {
  it('rounds the reported box outwards to 1e-5 degrees and turns it into lon and lat ranges', () => {
    expect(roundBounds(BOX)).toEqual({ west: -122.61235, south: 37.4, east: -122, north: 37.9 });
    // Values already on the 1e-5 grid stay put (no floating-point creep outwards).
    expect(roundBounds({ west: -122.4, south: 37.7, east: -121.1, north: 38.2 })).toEqual({ west: -122.4, south: 37.7, east: -121.1, north: 38.2 });
    const map = { spec: { lat: 'lat', lon: 'lon' }, viewport: roundBounds(BOX) } as Pick<MapViewState, 'spec' | 'viewport' | 'filterToView'>;
    expect(mapViewportFilters(map)).toEqual([
      { kind: 'range', column: 'lon', min: -122.61235, max: -122, minInclusive: true, maxInclusive: true },
      { kind: 'range', column: 'lat', min: 37.4, max: 37.9, minInclusive: true, maxInclusive: true },
    ]);
    expect(mapViewportFilters({ ...map, filterToView: false })).toEqual([]);
    expect(mapViewportFilters({ spec: map.spec })).toEqual([]);
    expect(viewportCondition(roundBounds(BOX))).toBe('37.400–37.900°N, 122.61–122.00°W');
    expect(viewportCondition({ west: 10, south: -1, east: 20, north: 2 })).toBe('1.000°S–2.000°N, 10.000–20.000°E');
  });

  it('filters every other view (charts, grid) and never the map itself; the filters compile on the flight columns', async () => {
    const { registry, store } = await flightsWorkspace();
    const mapId = mapOf(store.getState()).id;
    await registry.dispatch('setMapViewport', { mapId, bounds: BOX }, user);
    const state = store.getState();
    const viewport = mapViewportFilters(mapOf(state));
    expect(viewport).toHaveLength(2);
    expect(effectiveFilters(state, mapId)).toEqual([]);
    expect(effectiveFilters(state, 'grid')).toEqual(viewport);
    const queries = viewQueries(state);
    expect(queries.grid.filters).toEqual(viewport);
    for (const chart of queries.charts) {
      expect(chart.spec.filters).toEqual(viewport);
      // The compiler takes the ranges on the DECIMAL position columns.
      expect(() => compileChartQuery('"t"', chart.spec, stateColumns(state))).not.toThrow();
    }
    expect(compileWhere(viewport, stateColumns(state)).sql).toMatch(/"lon" >= .*"lon" <= .*"lat" >= .*"lat" <= /);
    // A brush on a chart filters the map (its latest-fix query), the map's viewport does not.
    await registry.dispatch('brush', { viewId: state.charts[0]?.id ?? '', selection: { type: 'interval', x: { min: 10_000, max: 20_000 } } }, user);
    const brushed = store.getState();
    const mapFilters = effectiveFilters(brushed, mapId);
    expect(mapFilters).toEqual([{ kind: 'range', column: 'altBaroFt', min: 10_000, max: 20_000, minInclusive: true, maxInclusive: false }]);
    expect(() => compileMapLatestQuery('"t"', { kind: 'map', filters: mapFilters }, stateColumns(brushed), { dataClockMs: 1_000 })).not.toThrow();
    // The histogram's own brush is excluded from itself but the viewport is not.
    expect(viewQueries(brushed).charts[0]?.spec.filters).toEqual(viewport);
    expect(viewQueries(brushed).charts[1]?.spec.filters).toEqual([...mapFilters, ...viewport]);
    // Cube targets for a brush on the histogram carry the viewport as a base filter.
    const plan = crossfilterPlan(brushed, brushed.charts[0]?.id ?? '');
    expect(plan?.targets.find((target) => target.kind === 'count')).toMatchObject({ filters: viewport });
  });

  it('two maps filter each other, each excluding only its own view', async () => {
    const { registry, store } = await flightsWorkspace();
    await registry.dispatch('addMapView', {}, user);
    const [a, b] = store.getState().maps as [MapViewState, MapViewState];
    await registry.dispatch('setMapViewport', { mapId: a.id, bounds: BOX }, user);
    await registry.dispatch('setMapViewport', { mapId: b.id, bounds: { west: -123, south: 37, east: -121.5, north: 38.5 } }, user);
    const state = store.getState();
    const [ma, mb] = state.maps as [MapViewState, MapViewState];
    expect(effectiveFilters(state, a.id)).toEqual(mapViewportFilters(mb));
    expect(effectiveFilters(state, b.id)).toEqual(mapViewportFilters(ma));
    expect(effectiveFilters(state, 'grid')).toEqual([...mapViewportFilters(ma), ...mapViewportFilters(mb)]);
  });

  it('property: a view never queries with its own viewport and gets every other active one once', () => {
    const bounds = fc
      .tuple(fc.double({ min: -123, max: -121, noNaN: true }), fc.double({ min: 0.01, max: 1, noNaN: true }), fc.double({ min: 36, max: 38, noNaN: true }), fc.double({ min: 0.01, max: 1, noNaN: true }))
      .map(([west, w, south, h]) => roundBounds({ west, south, east: west + w, north: south + h }));
    const map = fc.record({ viewport: fc.option(bounds, { nil: undefined }), filterToView: fc.option(fc.boolean(), { nil: undefined }) });
    fc.assert(
      fc.property(fc.array(map, { minLength: 1, maxLength: 4 }), (specs) => {
        const maps = specs.map((m, i): MapViewState => ({
          id: `map_${i}`,
          spec: { kind: 'map', lat: 'lat', lon: 'lon', id: 'hex', time: 'ts', filters: [], trailMinutes: 5 },
          ...(m.viewport === undefined ? {} : { viewport: m.viewport }),
          ...(m.filterToView === undefined ? {} : { filterToView: m.filterToView }),
        }));
        const state = { charts: [], selections: {}, userFilters: [], maps };
        for (const view of [...maps.map((m) => m.id), 'grid']) {
          const expected = maps.filter((m) => m.id !== view).flatMap((m) => mapViewportFilters(m));
          expect(effectiveFilters(state, view)).toEqual(expected);
        }
        // Chips: one per active viewport, whose removal turns that map's filter off.
        const chips = filterChips({ ...state, columns: [] });
        expect(chips.map((chip) => chip.remove)).toEqual(
          maps.filter((m) => m.filterToView !== false && m.viewport !== undefined).map((m) => ({ command: 'setMapViewFilter', input: { mapId: m.id, enabled: false } })),
        );
      }),
      { numRuns: 300 },
    );
  });

  it('chips: one per map view, labelled by the map, removed by turning its filter off', async () => {
    const { registry, store } = await flightsWorkspace();
    const mapId = mapOf(store.getState()).id;
    expect(filterChips(store.getState())).toEqual([]);
    await registry.dispatch('setMapViewport', { mapId, bounds: BOX }, user);
    const [chip] = filterChips(store.getState());
    expect(chip).toMatchObject({ id: `map:${mapId}`, viewId: mapId, column: 'Bay Area traffic view', condition: '37.400–37.900°N, 122.61–122.00°W' });
    expect(chip?.filters).toHaveLength(2);
    await registry.dispatch(chip?.remove.command ?? '', chip?.remove.input, user);
    expect(mapOf(store.getState()).filterToView).toBe(false);
    expect(filterChips(store.getState())).toEqual([]);
    expect(viewQueries(store.getState()).grid.filters).toEqual([]);
  });
});

describe('setMapViewport and setMapViewFilter', () => {
  it('panning records no undo entry, keeps the redo stack, and never dirties the workspace', async () => {
    const { registry, store } = await flightsWorkspace();
    const mapId = mapOf(store.getState()).id;
    // Something to redo.
    await registry.dispatch('addFilter', { filter: { kind: 'in', column: 'category', values: ['A3'] } }, user);
    await registry.dispatch('undo', {}, user);
    const history = store.getHistory();
    expect(history.future).toHaveLength(1);
    const digest = persistedDigest(store.getState());
    for (let i = 0; i < 100; i += 1) {
      const result = await registry.dispatch('setMapViewport', { mapId, bounds: { ...BOX, west: BOX.west + i * 1e-3 } }, user);
      expect(result.entryId).toBeNull();
    }
    expect(store.getHistory()).toEqual(history);
    expect(mapOf(store.getState()).viewport?.west).toBeCloseTo(BOX.west + 0.099, 4);
    // The viewport is view state: not saved, so panning never makes a saved workspace "unsaved".
    expect(persistedDigest(store.getState())).toBe(digest);
    expect(JSON.stringify(persistedWorkspace(store.getState()))).not.toContain('viewport');
    // Redo still redoes the filter.
    await registry.dispatch('redo', {}, user);
    expect(store.getState().userFilters).toHaveLength(1);
    // The same box again changes nothing (rounded equal).
    const same = store.getState();
    await registry.dispatch('setMapViewport', { mapId, bounds: { ...BOX, west: BOX.west + 0.099 } }, user);
    expect(store.getState()).toBe(same);
    // An unknown map is refused.
    await expect(registry.dispatch('setMapViewport', { mapId: 'map_404', bounds: BOX }, user)).rejects.toMatchObject({ code: 'precondition_failed' });
  });

  it('"Filter to map view" is one undo entry each way; undo and redo keep the current viewport', async () => {
    const { registry, store } = await flightsWorkspace();
    const mapId = mapOf(store.getState()).id;
    await registry.dispatch('setMapViewport', { mapId, bounds: BOX }, user);
    const off = await registry.dispatch('setMapViewFilter', { mapId, enabled: false }, user);
    expect(off.entryId).not.toBeNull();
    expect(viewQueries(store.getState()).grid.filters).toEqual([]);
    // Panned while off: no entry, and the newest box is what turning it back on uses.
    await registry.dispatch('setMapViewport', { mapId, bounds: { ...BOX, north: 38.2 } }, user);
    await registry.dispatch('undo', {}, user);
    expect(mapOf(store.getState()).filterToView).toBeUndefined();
    expect(viewQueries(store.getState()).grid.filters[1]).toMatchObject({ column: 'lat', max: 38.2 });
    await registry.dispatch('redo', {}, user);
    expect(mapOf(store.getState()).filterToView).toBe(false);
    // Turning on what is on records nothing.
    await registry.dispatch('setMapViewFilter', { mapId, enabled: true }, user);
    const entries = store.getHistory().past.length;
    expect((await registry.dispatch('setMapViewFilter', { mapId, enabled: true }, user)).entryId).toBeNull();
    expect(store.getHistory().past).toHaveLength(entries);
    // addMapView can start a map with its filter off.
    await registry.dispatch('addMapView', { filterToView: false }, user);
    expect(store.getState().maps[1]?.filterToView).toBe(false);
  });

  it('MCP: setMapViewFilter is exposed; setMapViewport is exempt with its reason (only the map knows what it shows)', async () => {
    const { registry, store } = await flightsWorkspace();
    const list = registry.list();
    expect(list.find((info) => info.name === 'setMapViewFilter')).toMatchObject({ tier: 'edit', mcp: { exposed: true } });
    expect(list.find((info) => info.name === 'setMapViewport')).toMatchObject({ tier: 'edit', mcp: { exposed: false, exemptReason: MCP_EXEMPTIONS.setMapViewport } });
    const mapId = mapOf(store.getState()).id;
    await expect(registry.dispatch('setMapViewport', { mapId, bounds: BOX }, ai)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(registry.dispatch('setMapViewFilter', { mapId, enabled: false }, ai)).resolves.toMatchObject({ entryId: expect.any(String) as unknown });
    // Bounds are checked: west ≤ east, south ≤ north, in range.
    await expect(registry.dispatch('setMapViewport', { mapId, bounds: { west: 1, south: 0, east: 0, north: 1 } }, user)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(registry.dispatch('setMapViewport', { mapId, bounds: { west: -200, south: 0, east: 0, north: 1 } }, user)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('removing a map takes its viewport (and filter) with it; undo brings both back', async () => {
    const { registry, store } = await flightsWorkspace();
    const mapId = mapOf(store.getState()).id;
    await registry.dispatch('setMapViewport', { mapId, bounds: BOX }, user);
    await registry.dispatch('removeMapView', { mapId }, user);
    expect(viewQueries(store.getState()).grid.filters).toEqual([]);
    await registry.dispatch('undo', {}, user);
    expect(viewQueries(store.getState()).grid.filters).toHaveLength(2);
  });
});

describe('the time cursor', () => {
  const range = { startMs: 1_000_000, endMs: 2_800_000 };

  it('resolves T: live follows the end, paused holds, playing advances at its speed; all clamped to the data', () => {
    expect(timeCursor({})).toBe(DEFAULT_TIME_CURSOR);
    expect(resolveTime(DEFAULT_TIME_CURSOR, range, 0)).toBe(2_800_000);
    expect(resolveTime(DEFAULT_TIME_CURSOR, null, 0)).toBeNull();
    expect(resolveTime({ mode: 'paused', atMs: 1_500_000, since: null, speed: 10 }, range, 9e9)).toBe(1_500_000);
    expect(resolveTime({ mode: 'paused', atMs: 10, since: null, speed: 10 }, range, 0)).toBe(1_000_000);
    const playing = { mode: 'playing' as const, atMs: 1_000_000, since: 50_000, speed: 10 };
    expect(resolveTime(playing, range, 50_000)).toBe(1_000_000);
    expect(resolveTime(playing, range, 40_000)).toBe(1_000_000);
    expect(resolveTime(playing, range, 51_000)).toBe(1_010_000);
    expect(resolveTime(playing, range, 50_000 + 180_000)).toBe(2_800_000);
    expect(playedToEnd(playing, range, 50_000 + 179_999)).toBe(false);
    expect(playedToEnd(playing, range, 50_000 + 180_000)).toBe(true);
    expect(playedToEnd({ ...playing, mode: 'paused' }, range, 9e9)).toBe(false);
  });

  it('setTime is view state: no undo entry, the redo stack kept, exposed to MCP; it needs an open file', async () => {
    const empty = testWorkspace();
    await expect(empty.registry.dispatch('setTime', { mode: 'paused', atMs: 1 }, user)).rejects.toMatchObject({ code: 'precondition_failed' });
    const { registry, store } = await flightsWorkspace();
    await registry.dispatch('undo', {}, user);
    const history = store.getHistory();
    const results = [
      await registry.dispatch('setTime', { mode: 'paused', atMs: 1_500_000 }, ai),
      await registry.dispatch('setTime', { mode: 'playing', atMs: 1_600_000, speed: 30 }, user),
      await registry.dispatch('setTime', { mode: 'live' }, ai),
    ];
    expect(results.map((result) => result.entryId)).toEqual([null, null, null]);
    expect(store.getHistory()).toEqual(history);
    expect(store.getState().time).toEqual({ mode: 'live', atMs: null, since: null, speed: 30 });
    await registry.dispatch('setTime', { mode: 'playing', atMs: 1_600_000 }, user);
    expect(store.getState().time).toMatchObject({ mode: 'playing', atMs: 1_600_000, speed: 30, since: expect.any(Number) as unknown });
    expect(registry.list().find((info) => info.name === 'setTime')).toMatchObject({ tier: 'edit', mcp: { exposed: true } });
    await expect(registry.dispatch('setTime', { mode: 'paused' }, user)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(registry.dispatch('setTime', { mode: 'playing', atMs: 1, speed: 500 }, user)).rejects.toMatchObject({ code: 'invalid_input' });
    // Not saved.
    expect(JSON.stringify(persistedWorkspace(store.getState()))).not.toContain('"time"');
  });

  it('charts follow the cursor (undoably) with a window of 5 minutes up to T; maps never take it', async () => {
    const { registry, store } = await flightsWorkspace();
    const at = Date.parse('2026-11-09T23:45:00.000Z');
    expect(timeWindowFilter(store.getState(), 'ts', at)).toBeNull();
    const on = await registry.dispatch('setChartsFollowTime', { enabled: true }, ai);
    expect(on.entryId).not.toBeNull();
    const state = store.getState();
    const window = timeWindowFilter(state, 'ts', at);
    expect(window).toEqual({ kind: 'range', column: 'ts', min: at - TIME_FOLLOW_WINDOW_MS, max: at, minInclusive: false, maxInclusive: true });
    expect(timeWindowFilter(state, 'ts', null)).toBeNull();
    const queries = viewQueries(state, { timeFilter: window });
    expect(queries.grid.filters).toEqual([window]);
    expect(queries.charts.every((chart) => JSON.stringify(chart.spec.filters) === JSON.stringify([window]))).toBe(true);
    expect(() => compileWhere([window as NonNullable<typeof window>], stateColumns(state))).not.toThrow();
    expect(effectiveFilters(state, mapOf(state).id)).toEqual([]);
    const chip = filterChips(state, { timeFilter: window }).find((candidate) => candidate.id === 'time');
    expect(chip).toMatchObject({ column: 'ts', condition: 'last 5 min to 2026-11-09 23:45', remove: { command: 'setChartsFollowTime', input: { enabled: false } } });
    await registry.dispatch('undo', {}, user);
    expect(store.getState().chartsFollowTime).toBeUndefined();
  });

  it('opening a file or loading a workspace resets the cursor and the follow switch (undo restores them)', async () => {
    const { registry, store } = await flightsWorkspace();
    await registry.dispatch('setTime', { mode: 'paused', atMs: 5 }, user);
    await registry.dispatch('setChartsFollowTime', { enabled: true }, user);
    await registry.dispatch('openFile', openFileInput(), user);
    expect(store.getState().time).toBeUndefined();
    expect(store.getState().chartsFollowTime).toBeUndefined();
    await registry.dispatch('undo', {}, user);
    expect(store.getState().time).toMatchObject({ mode: 'paused', atMs: 5 });
    expect(store.getState().chartsFollowTime).toBe(true);
  });
});

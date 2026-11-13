import { describe, expect, it } from 'vitest';
import { LIVE_FLIGHTS_FINGERPRINT, LIVE_FLIGHTS_HANDLE, LIVE_FLIGHTS_TABLE_NAME } from '../flights/table.js';
import { MAX_MAP_VIEWS } from '../state/workspace.js';
import { openFileInput, testWorkspace } from './test-support.js';

/*
 * addMapView / updateMapView / removeMapView (docs/live-flights-l3-data.md):
 * state commands, tier `edit`, exposed to MCP, undoable with Immer patches.
 */

const user = { caller: 'user' as const };
const ai = { caller: 'ai' as const };

/** The flight-point layout, as the engine reports `flight_states`. */
const FLIGHT_COLUMNS = [
  { name: 'ts', type: 'timestamp' },
  { name: 'hex', type: 'text' },
  { name: 'flight', type: 'text' },
  { name: 'typeCode', type: 'text' },
  { name: 'lat', type: 'decimal' },
  { name: 'lon', type: 'decimal' },
  { name: 'altBaroFt', type: 'integer' },
  { name: 'onGround', type: 'boolean' },
  { name: 'category', type: 'text' },
] as const;

async function liveWorkspace() {
  const workspace = testWorkspace();
  await workspace.registry.dispatch(
    'openFile',
    openFileInput({ handleId: LIVE_FLIGHTS_HANDLE, fileName: LIVE_FLIGHTS_TABLE_NAME, fingerprint: { ...LIVE_FLIGHTS_FINGERPRINT }, columns: FLIGHT_COLUMNS.map((c) => ({ ...c })) }),
    user,
  );
  return workspace;
}

describe('map view commands', () => {
  it('are edit-tier state commands exposed to MCP', () => {
    const { registry } = testWorkspace();
    for (const name of ['addMapView', 'updateMapView', 'removeMapView']) {
      expect(registry.list().find((info) => info.name === name)).toMatchObject({ tier: 'edit', mcp: { exposed: true } });
    }
    const add = registry.list().find((info) => info.name === 'addMapView');
    expect(JSON.stringify(add?.inputSchema)).toContain('trailMinutes');
  });

  it('adds a map with the flight-point defaults and a layout card; undo and redo replay the patches', async () => {
    const { registry, store } = await liveWorkspace();
    await registry.dispatch('addChart', { spec: { mark: 'bar', x: { column: 'category' } } }, user);
    const before = store.getState();
    const { state, entryId } = await registry.dispatch('addMapView', {}, ai);
    expect(entryId).not.toBeNull();
    const map = state.maps.at(-1);
    expect(map).toEqual({ id: expect.stringMatching(/^map_\d+$/) as string, spec: { kind: 'map', lat: 'lat', lon: 'lon', id: 'hex', time: 'ts', filters: [], trailMinutes: 5 } });
    expect(state.layout.cards.at(-1)).toEqual({ chartId: map?.id, x: 0, y: 1, w: 1, h: 1 });
    expect(store.getHistory().past.at(-1)).toMatchObject({ name: 'addMapView', caller: 'ai' });

    await registry.dispatch('undo', {}, user);
    expect(store.getState()).toEqual(before);
    await registry.dispatch('redo', {}, user);
    expect(store.getState().maps).toEqual(state.maps);
  });

  it('takes a full spec and a title, and checks it against the columns', async () => {
    const { registry } = await liveWorkspace();
    const { state } = await registry.dispatch(
      'addMapView',
      { spec: { kind: 'map', trailMinutes: 12, filters: [{ kind: 'range', column: 'altBaroFt', min: 10_000 }] }, title: '  High flyers ' },
      user,
    );
    expect(state.maps[0]).toMatchObject({ title: 'High flyers', spec: { trailMinutes: 12, filters: [{ kind: 'range', column: 'altBaroFt', min: 10_000 }] } });

    await expect(registry.dispatch('addMapView', { spec: { kind: 'map', lat: 'latitude' } }, ai)).rejects.toMatchObject({
      code: 'precondition_failed',
      issues: [{ path: 'spec.lat', message: 'Unknown column' }],
    });
    await expect(registry.dispatch('addMapView', { spec: { kind: 'map', lat: 'flight' } }, ai)).rejects.toMatchObject({
      code: 'precondition_failed',
      issues: [{ path: 'spec.lat' }],
      message: expect.stringContaining('lat must be a numeric column') as string,
    });
    await expect(registry.dispatch('addMapView', { spec: { kind: 'map', trailMinutes: 31 } }, ai)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(registry.dispatch('addMapView', { spec: { kind: 'map' }, colour: 'red' }, ai)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('refuses a map without a file, over a table without flight columns, or beyond the limit', async () => {
    const empty = testWorkspace();
    await expect(empty.registry.dispatch('addMapView', {}, ai)).rejects.toThrow('No file is open');
    const sales = testWorkspace();
    await sales.registry.dispatch('openFile', openFileInput(), user);
    await expect(sales.registry.dispatch('addMapView', {}, ai)).rejects.toThrow('Unknown column "lat"');

    const { registry, store } = await liveWorkspace();
    for (let i = 0; i < MAX_MAP_VIEWS; i += 1) await registry.dispatch('addMapView', {}, user);
    await expect(registry.dispatch('addMapView', {}, user)).rejects.toThrow(`at most ${MAX_MAP_VIEWS} map views`);
    expect(store.getState().maps).toHaveLength(MAX_MAP_VIEWS);
  });

  it('updates the trail, filters, columns and title, undoably', async () => {
    const { registry, store } = await liveWorkspace();
    const { state } = await registry.dispatch('addMapView', {}, user);
    const mapId = state.maps[0]?.id ?? '';
    await registry.dispatch('updateMapView', { mapId, trailMinutes: 30, title: 'Bay Area' }, ai);
    expect(store.getState().maps[0]).toEqual({ id: mapId, title: 'Bay Area', spec: { kind: 'map', lat: 'lat', lon: 'lon', id: 'hex', time: 'ts', filters: [], trailMinutes: 30 } });
    await registry.dispatch('updateMapView', { mapId, filters: [{ kind: 'notNull', column: 'flight' }], title: null }, ai);
    expect(store.getState().maps[0]).toEqual({ id: mapId, spec: { kind: 'map', lat: 'lat', lon: 'lon', id: 'hex', time: 'ts', filters: [{ kind: 'notNull', column: 'flight' }], trailMinutes: 30 } });

    await registry.dispatch('undo', {}, user);
    expect(store.getState().maps[0]).toMatchObject({ title: 'Bay Area', spec: { filters: [] } });
    await registry.dispatch('undo', {}, user);
    expect(store.getState().maps[0]).toEqual(state.maps[0]);

    await expect(registry.dispatch('updateMapView', { mapId }, ai)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(registry.dispatch('updateMapView', { mapId, time: 'hex' }, ai)).rejects.toMatchObject({ code: 'precondition_failed', issues: [{ path: 'time' }] });
    await expect(registry.dispatch('updateMapView', { mapId: 'map_99', trailMinutes: 1 }, ai)).rejects.toThrow(`Unknown map "map_99"; maps are "${mapId}"`);
  });

  it('removes a map and its card; undo brings both back; openFile clears maps', async () => {
    const { registry, store } = await liveWorkspace();
    const { state } = await registry.dispatch('addMapView', {}, user);
    const mapId = state.maps[0]?.id ?? '';
    await registry.dispatch('removeMapView', { mapId }, ai);
    expect(store.getState()).toMatchObject({ maps: [], layout: { cards: [] } });
    await registry.dispatch('undo', {}, user);
    expect(store.getState().maps).toEqual(state.maps);
    expect(store.getState().layout.cards).toEqual(state.layout.cards);
    await expect(registry.dispatch('removeMapView', { mapId: 'map_99' }, ai)).rejects.toThrow('Unknown map "map_99"');

    await registry.dispatch('openFile', openFileInput(), user);
    expect(store.getState().maps).toEqual([]);
  });
});

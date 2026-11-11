/**
 * @vitest-environment jsdom
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_FLIGHTS_FINGERPRINT,
  LIVE_FLIGHTS_HANDLE,
  LIVE_FLIGHTS_TABLE_ID,
  type LiveSourceConfigInput,
  type LiveSourceState,
  type LiveState,
  type LiveStatus,
  type TableHandle,
} from '@glassgrid/core';
import type { MapViewProps } from '@glassgrid/ui/map';
import type * as UiMap from '@glassgrid/ui/map';
import { App } from './App';
import { FLIGHTS_SAMPLE_REPLAY, openLiveFlightsWorkspace } from './flights';
import { fakeEngine, mapTable } from './test-support/fake-engine';
import { MAP_TRACK_STEP_MS } from './views/map-data';
import { fakePlatform } from './test-support/fake-platform';
import { stubLayout } from './test-support/jsdom';
import { createAppWorkspace } from './workspace';

/*
 * Map views in the app (docs/live-flights-l3-data.md), with the map
 * component replaced by one that records its props: the flights workspace
 * opens over the live table, each live batch re-queries the map (latest
 * fixes and trails at the batch's clock) and the other views, replies for
 * an older clock are dropped, and the component gets the contract's props.
 */

const rendered: MapViewProps[] = [];
/** Make the recording component fail: while rendering, or in its effect cleanup (as MapView's teardown once did). */
const failure = { render: false, unmount: false };
vi.mock('@glassgrid/ui/map', async (importOriginal) => {
  const { useEffect } = await import('react');
  return {
    // The real legend and band helpers (no MapLibre in them); the component replaced.
    ...(await importOriginal<typeof UiMap>()),
    loadMapView: () =>
      Promise.resolve(function RecordingMapView(props: MapViewProps) {
        rendered.push(props);
        if (failure.render) throw new Error('WebGL went away');
        useEffect(
          () => () => {
            if (failure.unmount) throw new TypeError("Cannot read properties of undefined (reading 'off')");
          },
          [],
        );
        return <div data-testid="map-view" data-aircraft={props.aircraft.length} />;
      }),
  };
});

const lastProps = (): MapViewProps => {
  const props = rendered.at(-1);
  if (!props) throw new Error('the map view never rendered');
  return props;
};

const CLOCK = Date.parse('2026-11-09T23:40:00.000Z');
const ATTRIBUTION = 'Data © adsb.lol contributors, ODbL 1.0';
const BASEMAP = '© OpenStreetMap contributors';

const liveHandle: TableHandle = {
  id: LIVE_FLIGHTS_TABLE_ID,
  file: LIVE_FLIGHTS_HANDLE,
  fileName: 'flight_states',
  rowCount: 0,
  fingerprint: { ...LIVE_FLIGHTS_FINGERPRINT },
  usingParquetCache: false,
  columns: [
    { name: 'ts', type: 'timestamp', duckdbType: 'TIMESTAMP' },
    { name: 'hex', type: 'text', duckdbType: 'VARCHAR' },
    { name: 'flight', type: 'text', duckdbType: 'VARCHAR' },
    { name: 'lat', type: 'decimal', duckdbType: 'DECIMAL(7,5)' },
    { name: 'lon', type: 'decimal', duckdbType: 'DECIMAL(8,5)' },
    { name: 'altBaroFt', type: 'integer', duckdbType: 'INTEGER' },
    { name: 'category', type: 'text', duckdbType: 'VARCHAR' },
  ],
};

function liveState(
  clock: number | null,
  options: { paused?: boolean; status?: LiveStatus; feed?: Partial<LiveSourceState>; rowCount?: number } = {},
): LiveState {
  return {
    source: options.feed?.kind === 'live' ? { kind: 'live', intervalMs: 20_000 } : { kind: 'replay', fixture: 'flights-bay-30min', intervalMs: 2_000, speed: 5 },
    feed: {
      kind: 'replay',
      status: options.status ?? (clock === null ? 'connecting' : 'live'),
      paused: options.paused ?? false,
      attribution: ATTRIBUTION,
      license: 'ODbL-1.0',
      lastSuccessAt: null,
      dataClockMs: clock,
      nextAttemptAt: null,
      failures: 0,
      error: null,
      ended: false,
      ...options.feed,
    },
    rowCount: options.rowCount ?? (clock === null ? 0 : 1_000),
    lastBatch: clock === null ? null : { received: 100, inserted: 100, expired: 0, dataClockMs: clock },
    ingestError: null,
  };
}

function setup(options: { map?: boolean } = {}) {
  let id = 0;
  const workspace = createAppWorkspace({ clock: () => 1_000, newId: (prefix) => `${prefix}_${++id}` });
  const listeners = new Set<(state: LiveState) => void>();
  let current = liveState(null);
  const live = {
    start: vi.fn((_source: LiveSourceConfigInput) => Promise.resolve(current)),
    stop: vi.fn(() => Promise.resolve(current)),
    setSource: vi.fn(() => Promise.resolve(current)),
    state: vi.fn(() => Promise.resolve(current)),
    setVisible: vi.fn(() => Promise.resolve()),
    onState: (listener: (state: LiveState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const base = fakeEngine();
  const engine = { ...base, live, open: vi.fn(() => Promise.resolve({ table: liveHandle, engineMs: 1 })) };
  const fake = fakePlatform(engine, options.map === false ? {} : { map: { assetsBase: '/glassgrid/map/', attribution: [BASEMAP] } });
  render(<App platform={fake.platform} workspace={workspace} initialOpen={() => openLiveFlightsWorkspace(FLIGHTS_SAMPLE_REPLAY, { engine, registry: workspace.registry })} />);
  const batch = (state: LiveState) => {
    current = state;
    act(() => listeners.forEach((listener) => listener(state)));
  };
  return { engine, live, workspace, batch };
}

beforeEach(() => {
  stubLayout();
  rendered.length = 0;
  failure.render = false;
  failure.unmount = false;
});
afterEach(() => cleanup());

describe('map views', () => {
  it('the flights workspace starts the replay and opens a map, an altitude histogram and a category bar over flight_states', async () => {
    const { engine, live, workspace } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    expect(live.start).toHaveBeenCalledWith({ kind: 'replay', fixture: 'flights-bay-30min', intervalMs: 2_000, speed: 5 });
    expect(engine.open).toHaveBeenCalledWith(LIVE_FLIGHTS_HANDLE);
    const state = workspace.store.getState();
    expect(state.dataSource).toMatchObject({ handleId: LIVE_FLIGHTS_HANDLE, fileName: 'flight_states' });
    expect(state.charts.map((chart) => chart.spec.mark)).toEqual(['histogram', 'bar']);
    expect(state.maps[0]).toMatchObject({ id: 'map_1', title: 'Bay Area traffic', spec: { kind: 'map', trailMinutes: 5 } });
    expect(workspace.store.getHistory().past.map((entry) => entry.name)).toEqual(['loadWorkspace']);
    // The map component loads; with no batch yet there is nothing to ask for.
    await screen.findByTestId('map-view');
    expect(screen.getByTestId('map-map_1-status').textContent).toBe('Starting the replay…');
    expect(engine.mapQuery).not.toHaveBeenCalled();
  });

  it('after a batch the component gets the batch’s aircraft and trails, its clock, the feed’s state and both credits', async () => {
    const { engine, workspace, batch } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    await screen.findByTestId('map-view');
    const aggregates = engine.aggregate.mock.calls.length;

    batch(liveState(CLOCK));
    await waitFor(() => expect(lastProps().aircraft).toHaveLength(2));
    const spec = { kind: 'map', lat: 'lat', lon: 'lon', id: 'hex', time: 'ts', filters: [], trailMinutes: 5 };
    expect(engine.mapQuery).toHaveBeenCalledWith(LIVE_FLIGHTS_TABLE_ID, { spec, dataClockMs: CLOCK, query: 'latest' }, { viewId: 'map:map_1:latest' });
    expect(engine.mapQuery).toHaveBeenCalledWith(LIVE_FLIGHTS_TABLE_ID, { spec, dataClockMs: CLOCK, query: 'trails' }, { viewId: 'map:map_1:trails' });
    const props = lastProps();
    expect(props.aircraft).toEqual([
      { hex: 'a1b2c3', flight: 'UAL1', typeCode: 'B738', category: 'A3', lat: 37.61, lon: -122.37, altBaroFt: 3_000, altGeomFt: 3_100, onGround: false, gsKt: 250.5, trackDeg: 45, baroRateFpm: 600, ts: CLOCK - 10_000, registration: 'N12345' },
      { hex: 'b2c3d4', flight: 'SWA2', typeCode: 'B737', category: 'A3', lat: 37.7, lon: -122.2, altBaroFt: 0, altGeomFt: 0, onGround: true, gsKt: 12, trackDeg: 180, baroRateFpm: 0, ts: CLOCK, registration: null },
    ]);
    expect(props.trails).toEqual([
      { hex: 'a1b2c3', ts: CLOCK - 20_000, lat: 37.6, lon: -122.38, altBaroFt: 2_500 },
      { hex: 'a1b2c3', ts: CLOCK - 10_000, lat: 37.61, lon: -122.37, altBaroFt: 3_000 },
      { hex: 'b2c3d4', ts: CLOCK, lat: 37.7, lon: -122.2, altBaroFt: 0 },
    ]);
    expect(props).toMatchObject({
      dataClockMs: CLOCK,
      playing: true,
      speed: 5,
      attribution: [ATTRIBUTION, BASEMAP],
      theme: 'light',
      assetsBase: '/glassgrid/map/',
      selectedHex: null,
      initialView: { center: [-122.25, 37.75], zoom: 8 },
    });
    expect(typeof props.aircraft[0]?.ts).toBe('number');
    expect(screen.getByTestId('map-map_1-status').textContent).toBe('Replay 5× · 2 aircraft');
    // The charts over flight_states re-query with the batch too.
    await waitFor(() => expect(engine.aggregate.mock.calls.length).toBeGreaterThanOrEqual(aggregates + 2));

    // A paused (hidden) or stopped feed does not play.
    batch(liveState(CLOCK, { paused: true }));
    await waitFor(() => expect(lastProps().playing).toBe(false));
  });

  it('drops replies for an older clock: the map shows the newest batch, aircraft and trails from the same clock', async () => {
    const { engine, workspace, batch } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    await screen.findByTestId('map-view');
    const pending: Array<{ clock: number; query: string; resolve: () => void }> = [];
    engine.mapQuery.mockImplementation((_table: string, request: { query: string; dataClockMs: number }) =>
      new Promise((resolve) => {
        pending.push({ clock: request.dataClockMs, query: request.query, resolve: () => resolve({ table: mapTable(request.query, request.dataClockMs), engineMs: 1, cached: false }) });
      }),
    );
    batch(liveState(CLOCK));
    await waitFor(() => expect(pending).toHaveLength(2));
    batch(liveState(CLOCK + 10_000));
    await waitFor(() => expect(pending).toHaveLength(4));
    // The newer clock answers first; the older one late.
    await act(async () => {
      for (const reply of pending.filter((p) => p.clock === CLOCK + 10_000)) reply.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(lastProps().dataClockMs).toBe(CLOCK + 10_000));
    await act(async () => {
      for (const reply of pending.filter((p) => p.clock === CLOCK)) reply.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const props = lastProps();
    expect(props.dataClockMs).toBe(CLOCK + 10_000);
    expect(props.aircraft.map((aircraft) => aircraft.ts)).toEqual([CLOCK, CLOCK + 10_000]);
    expect(props.trails.at(-1)?.ts).toBe(CLOCK + 10_000);
  });

  it('selecting an aircraft is UI state; the viewport filters the charts and the grid, never the map; filters re-query the map', async () => {
    const { engine, workspace, batch } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    batch(liveState(CLOCK));
    await waitFor(() => expect(lastProps().aircraft).toHaveLength(2));
    const history = workspace.store.getHistory().past.length;

    act(() => lastProps().onSelect?.('a1b2c3'));
    expect(lastProps().selectedHex).toBe('a1b2c3');
    const calls = engine.mapQuery.mock.calls.filter((call) => (call[1] as { query: string }).query !== 'track').length;
    const aggregates = engine.aggregate.mock.calls.length;
    act(() => lastProps().onViewportChange?.({ west: -122.6, south: 37.4, east: -122.0, north: 37.9 }));
    // L4: the viewport is the map's selection. No undo entry; the map itself does not re-query (it is never
    // filtered by its own view); the charts and the grid do, with lon and lat ranges.
    expect(workspace.store.getState().maps[0]?.viewport).toEqual({ west: -122.6, south: 37.4, east: -122, north: 37.9 });
    expect(workspace.store.getHistory().past.length).toBe(history);
    const box = [
      { kind: 'range', column: 'lon', min: -122.6, max: -122, minInclusive: true, maxInclusive: true },
      { kind: 'range', column: 'lat', min: 37.4, max: 37.9, minInclusive: true, maxInclusive: true },
    ];
    await waitFor(() => expect(engine.aggregate.mock.calls.length).toBeGreaterThanOrEqual(aggregates + 2));
    for (const call of engine.aggregate.mock.calls.slice(aggregates)) expect((call[1] as unknown as { filters: unknown[] }).filters).toEqual(box);
    await waitFor(() => expect(engine.count).toHaveBeenLastCalledWith(LIVE_FLIGHTS_TABLE_ID, expect.objectContaining({ filters: box })));
    expect(engine.mapQuery.mock.calls.filter((call) => (call[1] as { query: string }).query !== 'track').length).toBe(calls);
    // Shown short ("Map view"), named in full (the box in its accessible name and tooltip).
    expect(screen.getByTestId('filter-map-map_1').textContent).toBe('Map view×');
    expect(screen.getByTestId('filter-map-map_1').getAttribute('aria-label')).toBe('Filter Bay Area traffic view 37.400–37.900°N, 122.60–122.00°W');
    expect(screen.getByTestId('filter-map-map_1').getAttribute('title')).toBe('Bay Area traffic view 37.400–37.900°N, 122.60–122.00°W');
    act(() => lastProps().onSelect?.(null));
    expect(lastProps().selectedHex).toBeNull();

    // A filter from anywhere (here an agent's addFilter) applies to the map's latest fixes.
    await act(() => workspace.registry.dispatch('addFilter', { filter: { kind: 'in', column: 'category', values: ['A3'] } }, { caller: 'ai' }));
    await waitFor(() =>
      expect(engine.mapQuery).toHaveBeenLastCalledWith(
        LIVE_FLIGHTS_TABLE_ID,
        expect.objectContaining({ spec: expect.objectContaining({ filters: [{ kind: 'in', column: 'category', values: ['A3'] }] }) as unknown }),
        expect.anything(),
      ),
    );
  });

  it('"Filter to map view" switches the viewport filter off and on, one undo entry each; its chip turns it off', async () => {
    const { engine, workspace, batch } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    batch(liveState(CLOCK));
    await waitFor(() => expect(lastProps().aircraft).toHaveLength(2));
    act(() => lastProps().onViewportChange?.({ west: -122.6, south: 37.4, east: -122.0, north: 37.9 }));
    const toggle = screen.getByTestId<HTMLInputElement>('map-map_1-filter');
    expect(toggle.checked).toBe(true);
    expect(toggle.closest('label')?.textContent).toContain('Filter to map view');
    const entries = workspace.store.getHistory().past.length;
    fireEvent.click(toggle);
    await waitFor(() => expect(workspace.store.getState().maps[0]?.filterToView).toBe(false));
    expect(workspace.store.getHistory().past.length).toBe(entries + 1);
    expect(screen.queryByTestId('filter-map-map_1')).toBeNull();
    await waitFor(() => expect(engine.count).toHaveBeenLastCalledWith(LIVE_FLIGHTS_TABLE_ID, expect.objectContaining({ filters: [] })));
    // Panning while off records the box (for when it is turned on) and re-queries nothing.
    const counts = engine.count.mock.calls.length;
    act(() => lastProps().onViewportChange?.({ west: -122.5, south: 37.5, east: -122.1, north: 37.8 }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.count.mock.calls.length).toBe(counts);
    await act(() => workspace.registry.dispatch('undo', {}, { caller: 'user' }));
    expect(screen.getByTestId<HTMLInputElement>('map-map_1-filter').checked).toBe(true);
    await waitFor(() => expect(screen.getByTestId('filter-map-map_1').getAttribute('aria-label')).toContain('37.500–37.800°N'));
    // Removing the chip turns the filter off (the next pan would bring a cleared box back otherwise).
    fireEvent.click(screen.getByTestId('filter-map-map_1').querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(workspace.store.getState().maps[0]?.filterToView).toBe(false));
  });

  it('selecting an aircraft queries its track up to T, draws it, and shows its details; Close and Escape clear it', async () => {
    const { engine, workspace, batch } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    batch(liveState(CLOCK));
    await waitFor(() => expect(lastProps().aircraft).toHaveLength(2));
    expect(lastProps().selectedTrack).toEqual([]);
    act(() => lastProps().onSelect?.('a1b2c3'));
    await waitFor(() => expect(lastProps().selectedTrack).toHaveLength(4));
    expect(engine.mapQuery).toHaveBeenCalledWith(
      LIVE_FLIGHTS_TABLE_ID,
      expect.objectContaining({ query: 'track', aircraft: 'a1b2c3', dataClockMs: CLOCK }),
      { viewId: 'map:map_1:track' },
    );
    expect(lastProps().selectedTrack?.at(-1)).toEqual({ hex: 'a1b2c3', ts: CLOCK - 10_000, lat: 37.61, lon: -122.37, altBaroFt: 3_000 });
    const details = screen.getByRole('region', { name: 'Selected aircraft UAL1' });
    expect(details.textContent).toContain('CallsignUAL1');
    expect(details.textContent).toContain('TypeB738');
    expect(details.textContent).toContain('RegistrationN12345');
    expect(details.textContent).toContain('Altitude3,000 ft');
    expect(details.textContent).toContain('Speed250.5 kt');
    expect(details.textContent).toContain('Vertical rateClimbing 600 ft/min');
    expect(details.textContent).toContain('Last seen23:39:50 UTC, 10 s earlier');
    expect(screen.getByTestId('map-map_1-details-track').textContent).toBe('4 points to this time');
    expect(screen.getByTestId('map-map_1-selection').textContent).toBe('Selected UAL1');
    // New data asks again, up to T's next whole minute; the fixes after T are left out.
    batch(liveState(CLOCK + 2_000));
    await waitFor(() => expect(engine.mapQuery).toHaveBeenCalledWith(LIVE_FLIGHTS_TABLE_ID, expect.objectContaining({ query: 'track', dataClockMs: CLOCK + MAP_TRACK_STEP_MS }), { viewId: 'map:map_1:track' }));
    await waitFor(() => expect(lastProps().selectedTrack?.map((point) => point.ts)).toEqual([CLOCK + MAP_TRACK_STEP_MS - 600_000, CLOCK + MAP_TRACK_STEP_MS - 300_000]));
    fireEvent.click(screen.getByRole('button', { name: 'Clear the selection of UAL1' }));
    expect(lastProps().selectedHex).toBeNull();
    expect(lastProps().selectedTrack).toEqual([]);
    expect(screen.queryByTestId('map-map_1-details')).toBeNull();
  });

  it('a map that throws while it is removed leaves the app running; one that throws while drawing says so in its card', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { workspace, batch } = setup();
      await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
      await screen.findByTestId('map-view');
      batch(liveState(CLOCK));
      // Teardown: the card's Remove unmounts the component, whose cleanup throws.
      failure.unmount = true;
      fireEvent.click(screen.getByTestId('map-map_1-remove'));
      await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(0));
      expect(screen.getByTestId('app')).toBeTruthy();
      expect(screen.getByTestId('topbar').textContent).toContain('flight_states');
      expect(screen.getByTestId('maps-failed').textContent).toContain('A map stopped working.');
      failure.unmount = false;
      fireEvent.click(screen.getByRole('button', { name: 'Show the maps again' }));
      expect(screen.queryByTestId('maps-failed')).toBeNull();
      // Undo brings the map back; now it fails while rendering: only its card says so.
      await act(() => workspace.registry.dispatch('undo', {}, { caller: 'user' }));
      await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
      await screen.findByTestId('map-view');
      failure.render = true;
      batch(liveState(CLOCK + 2_000));
      await waitFor(() => expect(screen.getByTestId('map-map_1-failed').textContent).toContain('The map stopped working: WebGL went away'));
      expect(screen.getByTestId('map-map_1-status')).toBeTruthy();
      expect(screen.getByTestId('app')).toBeTruthy();
      failure.render = false;
      fireEvent.click(screen.getByRole('button', { name: 'Restart the map' }));
      await screen.findByTestId('map-view');
      expect(warn.mock.calls.some((call) => String(call[0]).startsWith('[glassgrid] map:'))).toBe(true);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('shows the altitude key over the map, clear of the attribution corner', async () => {
    const { workspace } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    await screen.findByTestId('map-view');
    const legend = screen.getByRole('list', { name: 'Bay Area traffic: aircraft altitude' });
    expect(legend.classList.contains('map-card__legend')).toBe(true);
    expect(screen.getByTestId('map-map_1').contains(legend)).toBe(true);
    expect([...legend.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '30,000 ft and above',
      '20,000–29,999 ft',
      '10,000–19,999 ft',
      '5,000–9,999 ft',
      '1,000–4,999 ft',
      'Below 1,000 ft',
      'On the ground',
      'Altitude unknown',
    ]);
  });

  it('the top bar shows the live table’s rows and the feed’s state, not a size', async () => {
    const { workspace, batch } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    const size = () => screen.getByTestId('file-size').textContent;
    expect(size()).not.toMatch(/\bB\b/);
    batch(liveState(CLOCK, { rowCount: 12_345 }));
    await waitFor(() => expect(size()).toBe('12,345 rows · Replay 5×'));
    batch(liveState(CLOCK, { rowCount: 71_595, status: 'stopped', feed: { ended: true } }));
    await waitFor(() => expect(size()).toBe('71,595 rows · Replay ended'));
    expect(screen.getByTestId('topbar').textContent).not.toContain('0 B');
  });

  it('the map’s status line follows the feed: connecting, live, stale, backing off with the next retry and the error, stopped', async () => {
    const { workspace, batch } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    await screen.findByTestId('map-view');
    const status = () => screen.getByTestId('map-map_1-status').textContent;
    const region = () => screen.getByTestId('map-map_1-feed');
    expect(region().getAttribute('aria-live')).toBe('polite');
    // ?live=1 with no relay: connecting, then backing off on 404s, never "Waiting for data…".
    batch(liveState(null, { feed: { kind: 'live', status: 'connecting', attribution: null } }));
    await waitFor(() => expect(status()).toBe('Connecting to the live feed…'));
    const next = Date.now() + 12_000;
    batch(liveState(null, { feed: { kind: 'live', status: 'backoff', failures: 3, error: 'http://localhost/api/flights: HTTP 404', nextAttemptAt: next } }));
    await waitFor(() => expect(status()).toMatch(/^Retrying in 1[12] s · HTTP 404$/));
    expect(screen.getByTestId('map-map_1-status').getAttribute('data-feed')).toBe('backoff');
    expect(region().textContent).toMatch(/^Bay Area traffic: The live feed is unavailable after 3 failed attempts: HTTP 404\. Next try at \d\d:\d\d:\d\d\.$/);
    // The countdown moves; the live region does not (it is announced once per change).
    const announced = region().textContent;
    await waitFor(() => expect(status()).toMatch(/^Retrying in (9|10) s/), { timeout: 3_000 });
    expect(region().textContent).toBe(announced);
    batch(liveState(CLOCK, { feed: { kind: 'live', status: 'live' } }));
    await waitFor(() => expect(status()).toBe('Live · 2 aircraft'));
    batch(liveState(CLOCK, { feed: { kind: 'live', status: 'stale', lastSuccessAt: CLOCK } }));
    await waitFor(() => expect(status()).toBe('Stale data · 2 aircraft'));
    expect(region().textContent).toMatch(/data is stale, last update at/);
    batch(liveState(CLOCK, { feed: { kind: 'live', status: 'stopped' } }));
    await waitFor(() => expect(status()).toBe('Stopped · 2 aircraft'));
  });

  it('passes the same empty arrays before the first snapshot (a new array would restart the map’s clock)', async () => {
    const { workspace, batch } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    await screen.findByTestId('map-view');
    const before = rendered.length;
    batch(liveState(null, { feed: { status: 'connecting', failures: 0 } }));
    batch(liveState(null, { paused: true }));
    await waitFor(() => expect(rendered.length).toBeGreaterThan(before + 1));
    const first = rendered[0] as MapViewProps;
    expect(rendered.every((props) => props.aircraft === first.aircraft && props.trails === first.trails)).toBe(true);
    expect(first.aircraft).toEqual([]);
  });

  it('clears the selected aircraft when no map shows it any more, and when the workspace changes', async () => {
    const { engine, workspace, batch } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    batch(liveState(CLOCK));
    await waitFor(() => expect(lastProps().aircraft).toHaveLength(2));
    act(() => lastProps().onSelect?.('a1b2c3'));
    expect(lastProps().selectedHex).toBe('a1b2c3');
    // The next batch still has it.
    batch(liveState(CLOCK + 2_000));
    await waitFor(() => expect(lastProps().dataClockMs).toBe(CLOCK + 2_000));
    expect(lastProps().selectedHex).toBe('a1b2c3');
    // Then it is gone (landed, left the box): the selection goes with it.
    engine.mapQuery.mockImplementation((_table: string, request: { query: string; dataClockMs: number }) => {
      // b2c3d4 only: the last row of the latest fixes, and of the trails.
      const table = mapTable(request.query, request.dataClockMs);
      return Promise.resolve({ table: table.slice(table.numRows - 1), engineMs: 1, cached: false });
    });
    batch(liveState(CLOCK + 4_000));
    await waitFor(() => expect(lastProps().aircraft.map((a) => a.hex)).toEqual(['b2c3d4']));
    await waitFor(() => expect(lastProps().selectedHex).toBeNull());
    // A workspace change (undo the flights workspace, redo it) clears it even when the aircraft is still there.
    engine.mapQuery.mockImplementation((_table: string, request: { query: string; dataClockMs: number }) =>
      Promise.resolve({ table: mapTable(request.query, request.dataClockMs), engineMs: 1, cached: false }),
    );
    batch(liveState(CLOCK + 6_000));
    await waitFor(() => expect(lastProps().aircraft).toHaveLength(2));
    act(() => lastProps().onSelect?.('a1b2c3'));
    expect(lastProps().selectedHex).toBe('a1b2c3');
    await act(() => workspace.registry.dispatch('undo', {}, { caller: 'user' }));
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(0));
    await act(() => workspace.registry.dispatch('redo', {}, { caller: 'user' }));
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    await waitFor(() => expect(lastProps().aircraft).toHaveLength(2));
    expect(lastProps().selectedHex).toBeNull();
  });

  it('adds and removes map views with the + Map button and the card’s Remove, undoably; a shell without a basemap says so', async () => {
    const { workspace } = setup({ map: false });
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    expect(screen.getByTestId('map-map_1').textContent).toContain('Maps are not available in this app yet.');
    fireEvent.click(screen.getByTestId('new-map'));
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(2));
    const added = workspace.store.getState().maps[1]?.id ?? '';
    fireEvent.click(screen.getByTestId(`map-${added}-remove`));
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    const undo = document.querySelector<HTMLButtonElement>('.toast-slot button');
    expect(undo?.textContent).toContain('Undo');
    fireEvent.click(undo as HTMLButtonElement);
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(2));
  });
});

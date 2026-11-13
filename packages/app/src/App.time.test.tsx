/**
 * @vitest-environment jsdom
 */
import { Profiler } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_FLIGHTS_FINGERPRINT,
  LIVE_FLIGHTS_HANDLE,
  LIVE_FLIGHTS_TABLE_ID,
  type LiveSourceConfigInput,
  type LiveSourceInput,
  type LiveState,
  type TableHandle,
} from '@glassgrid/core';
import type { MapViewProps } from '@glassgrid/ui/map';
import type * as UiMap from '@glassgrid/ui/map';
import { App, GRID_FOLLOW_MS } from './App';
import { FLIGHTS_SAMPLE_ARCHIVE, openLiveFlightsWorkspace } from './flights';
import { fakeEngine } from './test-support/fake-engine';
import { fakePlatform } from './test-support/fake-platform';
import { stubLayout } from './test-support/jsdom';
import { scrubSteps } from './time-format';
import { MAP_TRACK_STEP_MS } from './views/map-data';
import { createAppWorkspace } from './workspace';

/*
 * The time cursor in the app (milestone L4, docs/live-flights-l4.md): an
 * archive loaded whole plays from its first fix; the scrubber's slider and
 * keys seek (a re-query of the map at the new T, no undo entry); Play and
 * Pause drive dead reckoning; a live feed's Live switch holds T while
 * batches keep arriving; "Charts follow time" narrows the charts and the
 * grid to the 5 minutes up to T; "Load full day" swaps in the day fixture.
 */

const rendered: MapViewProps[] = [];
vi.mock('@glassgrid/ui/map', async (importOriginal) => ({
  ...(await importOriginal<typeof UiMap>()),
  loadMapView: () =>
    Promise.resolve(function RecordingMapView(props: MapViewProps) {
      rendered.push(props);
      return <div data-testid="map-view" data-aircraft={props.aircraft.length} />;
    }),
}));
const lastProps = (): MapViewProps => {
  const props = rendered.at(-1);
  if (!props) throw new Error('the map view never rendered');
  return props;
};

const START = Date.parse('2026-11-09T23:27:00.000Z');
const END = Date.parse('2026-11-09T23:57:59.990Z');

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
    { name: 'baroRateFpm', type: 'integer', duckdbType: 'INTEGER' },
    { name: 'category', type: 'text', duckdbType: 'VARCHAR' },
  ],
};

function archiveState(fixture: 'flights-bay-30min' | 'flights-bay-day', status: 'connecting' | 'live', end = END): LiveState {
  return {
    source: { kind: 'archive', fixture },
    feed: { kind: 'archive', status, paused: false, attribution: 'Data © adsb.lol contributors', license: 'ODbL-1.0', lastSuccessAt: 1, dataClockMs: status === 'live' ? end : null, nextAttemptAt: null, failures: 0, error: null, ended: false },
    rowCount: status === 'live' ? 71_595 : 0,
    lastBatch: status === 'live' ? { received: 71_595, inserted: 71_595, expired: 0, dataClockMs: end } : null,
    ingestError: null,
  };
}

function liveFeedState(clock: number): LiveState {
  return {
    source: { kind: 'live', intervalMs: 20_000 },
    feed: { kind: 'live', status: 'live', paused: false, attribution: 'Data © adsb.lol contributors', license: 'ODbL-1.0', lastSuccessAt: 1, dataClockMs: clock, nextAttemptAt: null, failures: 0, error: null, ended: false },
    rowCount: 500,
    lastBatch: { received: 50, inserted: 50, expired: 0, dataClockMs: clock },
    ingestError: null,
  };
}

function setup(source: LiveSourceInput = FLIGHTS_SAMPLE_ARCHIVE) {
  let id = 0;
  const wall = { now: 1_000_000 };
  const workspace = createAppWorkspace({ clock: () => wall.now, newId: (prefix) => `${prefix}_${++id}` });
  const listeners = new Set<(state: LiveState) => void>();
  let current: LiveState = { source: null, feed: null, rowCount: 0, lastBatch: null, ingestError: null };
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
  const engine = { ...fakeEngine(), live, open: vi.fn(() => Promise.resolve({ table: liveHandle, engineMs: 1 })) };
  const fake = fakePlatform(engine, { map: { assetsBase: '/map/', attribution: [] } });
  const commits = { count: 0 };
  render(
    <Profiler id="app" onRender={() => (commits.count += 1)}>
      <App platform={fake.platform} workspace={workspace} initialOpen={() => openLiveFlightsWorkspace(source, { engine, registry: workspace.registry })} />
    </Profiler>,
  );
  const batch = (state: LiveState) => {
    current = state;
    act(() => listeners.forEach((listener) => listener(state)));
  };
  /** The time column's profile (the scrubber's range starts at its min). */
  const profile = async (min: number, max: number) => {
    await act(async () => {
      await workspace.registry.dispatch(
        'setColumnProfiles',
        { columns: [{ name: 'ts', type: 'timestamp', distinctCount: 1_000, nullFraction: 0, min: new Date(min).toISOString().replace('T', ' ').replace('Z', ''), max: new Date(max).toISOString().replace('T', ' ').replace('Z', '') }] },
        { caller: 'user' },
      );
    });
  };
  return { engine, live, workspace, batch, profile, wall, commits };
}

const mapClocks = (engine: ReturnType<typeof setup>['engine']) =>
  engine.mapQuery.mock.calls.filter((call) => (call[1] as { query: string }).query === 'latest').map((call) => (call[1] as { dataClockMs: number }).dataClockMs);

beforeEach(() => {
  stubLayout();
  rendered.length = 0;
});
afterEach(() => cleanup());

describe('the time cursor', () => {
  it('an archive loads whole and plays from its first fix at 10×; the map is queried as of T, with dead reckoning', async () => {
    const { engine, live, workspace, batch, profile, wall } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    expect(live.start).toHaveBeenCalledWith({ kind: 'archive', fixture: 'flights-bay-30min' });
    expect(workspace.store.getState().charts.map((chart) => chart.title)).toEqual(['Barometric altitude (ft)', 'Fixes by emitter category', 'Vertical rate (ft/min)']);
    batch(archiveState('flights-bay-30min', 'connecting'));
    await waitFor(() => expect(screen.getByTestId('map-map_1-status').textContent).toBe('Loading recorded flights…'));
    batch(archiveState('flights-bay-30min', 'live'));
    await profile(START, END);
    await waitFor(() => expect(workspace.store.getState().time).toMatchObject({ mode: 'playing', atMs: START, speed: 10 }));
    expect(workspace.store.getHistory().past.map((entry) => entry.name)).toEqual(['loadWorkspace']);
    await waitFor(() => expect(mapClocks(engine)).toContain(START));
    await waitFor(() => expect(lastProps()).toMatchObject({ dataClockMs: START, playing: true, speed: 10 }));
    await waitFor(() => expect(screen.getByTestId('map-map_1-status').textContent).toMatch(/^Recorded · \d+ aircraft$/));
    expect(screen.getByTestId('time-range').textContent).toBe('Data: Nov 9, 2026, 23:27:00–23:57:59 UTC (31 min)');
    // A second of wall time later, T is 10 s on (the map re-queries once per tick; dead reckoning fills in).
    wall.now += 1_000;
    await waitFor(() => expect(mapClocks(engine)).toContain(START + 10_000), { timeout: 3_000 });
    expect(screen.getByTestId('time-now').textContent).toContain('23:27:10 UTC');
    // Pause: T holds, no dead reckoning.
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(lastProps().playing).toBe(false));
    expect(workspace.store.getState().time?.mode).toBe('paused');
    // Played to the end (wall time far on, then Play again near the end): the cursor holds at the end.
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    wall.now += 10_000_000;
    await waitFor(() => expect(workspace.store.getState().time).toMatchObject({ mode: 'paused', atMs: END }), { timeout: 3_000 });
    expect(lastProps()).toMatchObject({ dataClockMs: END, playing: false });
    // Play at the end starts over.
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(workspace.store.getState().time).toMatchObject({ mode: 'playing', atMs: START });
    expect(workspace.store.getHistory().past.map((entry) => entry.name)).toEqual(['loadWorkspace']);
  });

  it('the scrubber is a keyboard slider: arrows, Page Up / Down, Home and End seek (a re-query, no undo entry)', async () => {
    const { engine, workspace, batch, profile } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    batch(archiveState('flights-bay-30min', 'live'));
    await profile(START, END);
    await waitFor(() => expect(workspace.store.getState().time?.mode).toBe('playing'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const slider = screen.getByRole('slider', { name: 'Time shown on the map' });
    expect(slider.getAttribute('aria-valuemin')).toBe(String(START));
    expect(slider.getAttribute('aria-valuemax')).toBe(String(END));
    expect(scrubSteps(END - START)).toEqual({ step: 10_000, page: 120_000 });
    const at = () => Number(slider.getAttribute('aria-valuenow'));
    fireEvent.keyDown(slider, { key: 'End' });
    await waitFor(() => expect(at()).toBe(END));
    fireEvent.keyDown(slider, { key: 'PageDown' });
    await waitFor(() => expect(at()).toBe(END - 120_000));
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    await waitFor(() => expect(at()).toBe(END - 130_000));
    fireEvent.keyDown(slider, { key: 'ArrowUp' });
    fireEvent.keyDown(slider, { key: 'PageUp' });
    await waitFor(() => expect(at()).toBe(END));
    fireEvent.keyDown(slider, { key: 'Home' });
    await waitFor(() => expect(at()).toBe(START));
    fireEvent.keyDown(slider, { key: 'ArrowDown' });
    await waitFor(() => expect(at()).toBe(START));
    await waitFor(() => expect(slider.getAttribute('aria-valuetext')).toMatch(/^23:27:00 UTC, \d\d:\d\d:\d\d \S+/));
    expect(screen.getByTestId('time-now').textContent).toContain('23:27:00 UTC');
    await waitFor(() => expect(mapClocks(engine)).toEqual(expect.arrayContaining([END, END - 120_000, END - 130_000, START])));
    expect(workspace.store.getHistory().past.map((entry) => entry.name)).toEqual(['loadWorkspace']);
    // Seeking while playing plays on from the new T.
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await waitFor(() => expect(workspace.store.getState().time?.mode).toBe('playing'));
    fireEvent.keyDown(slider, { key: 'PageUp' });
    await waitFor(() => expect(workspace.store.getState().time).toMatchObject({ mode: 'playing', atMs: START + 120_000 }));
  });

  it('a live feed: Live follows the feed; off, T holds while batches keep coming; Go live returns to now', async () => {
    const { engine, workspace, batch, profile } = setup({ source: 'live' });
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    const now = Date.parse('2026-11-11T18:00:00.000Z');
    batch(liveFeedState(now));
    await profile(now - 3_600_000, now);
    const liveButton = await screen.findByTestId('time-live');
    expect(liveButton.getAttribute('aria-pressed')).toBe('true');
    expect(liveButton.textContent).toBe('Live');
    await waitFor(() => expect(lastProps()).toMatchObject({ dataClockMs: now, playing: true }));
    // Freeze: T stays at `now` while the feed polls on.
    fireEvent.click(liveButton);
    expect(workspace.store.getState().time).toMatchObject({ mode: 'paused', atMs: now });
    await waitFor(() => expect(screen.getByTestId('time-live').textContent).toBe('Go live'));
    const before = engine.mapQuery.mock.calls.length;
    batch(liveFeedState(now + 20_000));
    await waitFor(() => expect(engine.mapQuery.mock.calls.length).toBeGreaterThan(before));
    expect(mapClocks(engine).slice(-1)).toEqual([now]);
    expect(lastProps()).toMatchObject({ dataClockMs: now, playing: false });
    expect(screen.getByTestId('time-range').textContent).toContain('18:00:20');
    // Scrub back within the retained hour (it starts an hour before the newest batch, not at the profile's older
    // first fix, which that batch expired), then back to now.
    const slider = screen.getByRole('slider', { name: 'Time shown on the map' });
    fireEvent.keyDown(slider, { key: 'Home' });
    await waitFor(() => expect(Number(slider.getAttribute('aria-valuenow'))).toBe(now + 20_000 - 3_600_000));
    fireEvent.click(screen.getByTestId('time-live'));
    await waitFor(() => expect(lastProps().dataClockMs).toBe(now + 20_000));
    expect(workspace.store.getState().time?.mode).toBe('live');
    // No "Load full day" for live data.
    expect(screen.queryByTestId('time-load-day')).toBeNull();
  });

  it('paused on a live feed for longer than it keeps fixes: T is held at the oldest one kept, from the batch on, and the bar says so', async () => {
    const { engine, workspace, batch, profile } = setup({ source: 'live' });
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    const now = Date.parse('2026-11-11T18:00:00.000Z');
    batch(liveFeedState(now));
    await profile(now - 3_600_000, now);
    fireEvent.click(await screen.findByTestId('time-live'));
    const slider = screen.getByRole('slider', { name: 'Time shown on the map' });
    fireEvent.keyDown(slider, { key: 'Home' });
    await waitFor(() => expect(workspace.store.getState().time).toMatchObject({ mode: 'paused', atMs: now - 3_600_000 }));
    expect(screen.queryByTestId('time-expired')).toBeNull();
    // A batch 40 s on expires the paused time's fixes: with that batch (the profile not refreshed yet) T is at the
    // oldest fix kept, never at rows that are gone (an empty map).
    const before = mapClocks(engine).length;
    batch(liveFeedState(now + 40_000));
    await waitFor(() => expect(mapClocks(engine).length).toBeGreaterThan(before));
    expect(mapClocks(engine).slice(before)).not.toHaveLength(0);
    for (const clock of mapClocks(engine).slice(before)) expect(clock).toBe(now + 40_000 - 3_600_000);
    expect(screen.getByTestId('time-expired').textContent).toBe('Paused · older data has expired');
    expect(screen.getByTestId('time-expired').getAttribute('role')).toBe('status');
    // The cursor itself still says where it was paused; Go live clears it.
    expect(workspace.store.getState().time?.atMs).toBe(now - 3_600_000);
    fireEvent.click(screen.getByTestId('time-live'));
    await waitFor(() => expect(screen.queryByTestId('time-expired')).toBeNull());
  });

  it('"Charts follow time" narrows the charts and the grid to the 5 minutes up to T (undoable), with a chip', async () => {
    const { engine, workspace, batch, profile } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    batch(archiveState('flights-bay-30min', 'live'));
    await profile(START, END);
    await waitFor(() => expect(workspace.store.getState().time?.mode).toBe('playing'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const T = workspace.store.getState().time?.atMs ?? 0;
    const aggregates = engine.aggregate.mock.calls.length;
    fireEvent.click(screen.getByTestId('time-follow'));
    expect(workspace.store.getState().chartsFollowTime).toBe(true);
    expect(workspace.store.getHistory().past.at(-1)?.name).toBe('setChartsFollowTime');
    const window = { kind: 'range', column: 'ts', min: T - 300_000, max: T, minInclusive: false, maxInclusive: true };
    await waitFor(() => expect(engine.aggregate.mock.calls.length).toBeGreaterThanOrEqual(aggregates + 3));
    for (const call of engine.aggregate.mock.calls.slice(aggregates)) expect((call[1] as unknown as { filters: unknown[] }).filters).toContainEqual(window);
    await waitFor(() => expect(engine.count).toHaveBeenLastCalledWith(LIVE_FLIGHTS_TABLE_ID, expect.objectContaining({ filters: [window] })));
    // The map is "as of T" by its clock, not filtered by the window.
    expect((engine.mapQuery.mock.calls.at(-1)?.[1] as unknown as { spec: { filters: unknown[] } }).spec.filters).toEqual([]);
    expect(screen.getByTestId('filter-time').textContent).toContain('last 5 min to');
    // Its chip stops it; Undo brings it back.
    fireEvent.click(screen.getByTestId('filter-time').querySelector('button') as HTMLButtonElement);
    await waitFor(() => expect(workspace.store.getState().chartsFollowTime).toBeUndefined());
    await act(() => workspace.registry.dispatch('undo', {}, { caller: 'user' }));
    expect(workspace.store.getState().chartsFollowTime).toBe(true);
  });

  it('playing with "Charts follow time", the grid’s window moves on every few seconds (the charts’ every tick); paused, at once', async () => {
    const { engine, workspace, batch, profile, wall } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    batch(archiveState('flights-bay-30min', 'live'));
    await profile(START, END);
    await waitFor(() => expect(workspace.store.getState().time?.mode).toBe('playing'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    fireEvent.click(screen.getByTestId('time-follow'));
    const T = workspace.store.getState().time?.atMs ?? 0;
    wall.now = Math.ceil(wall.now / GRID_FOLLOW_MS) * GRID_FOLLOW_MS;
    const counts = engine.count.mock.calls.length;
    const aggregates = engine.aggregate.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    const windowEnd = (filters: readonly unknown[] | undefined) => (filters?.find((filter) => (filter as { column?: string }).column === 'ts') as { max?: number } | undefined)?.max;
    const chartEnds = () => new Set(engine.aggregate.mock.calls.slice(aggregates).map((call) => windowEnd((call[1] as unknown as { filters: unknown[] }).filters)));
    const gridEnds = () => new Set(engine.count.mock.calls.slice(counts).map((call) => windowEnd((call[1] as { filters?: unknown[] }).filters)));
    for (let tick = 1; tick < GRID_FOLLOW_MS / 1_000; tick += 1) {
      wall.now += 1_000;
      await waitFor(() => expect(chartEnds()).toContain(T + tick * 10_000), { timeout: 3_000 });
    }
    // Three ticks: the charts moved three times, the grid not at all.
    expect([...gridEnds()].filter((end) => end !== undefined && end !== T)).toEqual([]);
    wall.now += 1_000;
    await waitFor(() => expect(gridEnds()).toContain(T + GRID_FOLLOW_MS * 10), { timeout: 3_000 });
    // Paused part-way to the next step: the grid is at T at once.
    wall.now += 1_000;
    await waitFor(() => expect(chartEnds()).toContain(T + 50_000), { timeout: 3_000 });
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const paused = workspace.store.getState().time?.atMs ?? 0;
    await waitFor(() => expect(gridEnds()).toContain(paused));
  }, 20_000);

  it('playing with an aircraft selected, its track is asked for again only when T crosses a whole minute (cut back to T in between)', async () => {
    const { engine, workspace, batch, profile, wall } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    batch(archiveState('flights-bay-30min', 'live'));
    await profile(START, END);
    await waitFor(() => expect(workspace.store.getState().time?.mode).toBe('playing'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const T = workspace.store.getState().time?.atMs ?? 0;
    expect(T % MAP_TRACK_STEP_MS).toBe(0);
    await waitFor(() => expect(lastProps().aircraft.length).toBeGreaterThan(0));
    act(() => lastProps().onSelect?.('a1b2c3'));
    const tracks = () => engine.mapQuery.mock.calls.filter((call) => (call[1] as { query: string }).query === 'track').map((call) => (call[1] as { dataClockMs: number }).dataClockMs);
    await waitFor(() => expect(tracks()).toEqual([T]));
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    // Five ticks of 10 s: T stays inside the next minute, one query up to it; the track never reaches past T.
    for (let tick = 1; tick <= 5; tick += 1) {
      wall.now += 1_000;
      await waitFor(() => expect(lastProps().dataClockMs).toBe(T + tick * 10_000), { timeout: 3_000 });
      await waitFor(() => expect(Math.max(...(lastProps().selectedTrack ?? []).map((point) => point.ts))).toBeLessThanOrEqual(T + tick * 10_000));
      if (tick === 4) expect(lastProps().selectedTrack).toHaveLength(3);
    }
    expect(tracks()).toEqual([T, T + MAP_TRACK_STEP_MS]);
    // The fixes it holds past T showed up as T reached them (the fake's last two are 20 s and 10 s before the horizon).
    expect(lastProps().selectedTrack?.map((point) => point.ts)).toEqual([T + MAP_TRACK_STEP_MS - 600_000, T + MAP_TRACK_STEP_MS - 300_000, T + 40_000, T + 50_000]);
    // Past it: the next minute.
    wall.now += 2_000;
    await waitFor(() => expect(tracks()).toEqual([T, T + MAP_TRACK_STEP_MS, T + 2 * MAP_TRACK_STEP_MS]), { timeout: 3_000 });
  }, 20_000);

  it('with the map removed while it plays, the wall clock stops (no re-render every second for a cursor nobody sees)', async () => {
    const { workspace, batch, profile, wall, commits } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    batch(archiveState('flights-bay-30min', 'live'));
    await profile(START, END);
    await waitFor(() => expect(workspace.store.getState().time?.mode).toBe('playing'));
    // Playing with the map: a commit each tick.
    let before = commits.count;
    wall.now += 1_000;
    await waitFor(() => expect(commits.count).toBeGreaterThan(before), { timeout: 3_000 });
    fireEvent.click(screen.getByTestId('map-map_1-remove'));
    await waitFor(() => expect(screen.queryByTestId('time-bar')).toBeNull());
    expect(workspace.store.getState().time?.mode).toBe('playing');
    await new Promise((resolve) => setTimeout(resolve, 300));
    before = commits.count;
    wall.now += 1_000;
    await new Promise((resolve) => setTimeout(resolve, 2_300));
    expect(commits.count).toBe(before);
  }, 20_000);

  it('"Load full day" starts the day fixture; the cursor keeps T', async () => {
    const { engine, live, workspace, batch, profile } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    batch(archiveState('flights-bay-30min', 'live'));
    await profile(START, END);
    await waitFor(() => expect(workspace.store.getState().time?.mode).toBe('playing'));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    const T = workspace.store.getState().time?.atMs;
    fireEvent.click(screen.getByTestId('time-load-day'));
    await waitFor(() => expect(live.start).toHaveBeenLastCalledWith({ kind: 'archive', fixture: 'flights-bay-day' }));
    batch(archiveState('flights-bay-day', 'connecting'));
    await waitFor(() => expect(screen.getByTestId('time-load-day').textContent).toBe('Loading the full day…'));
    // The day's batch is in, its profile not yet: the range says so, never the half hour's start with the day's end.
    let answer: (value: Awaited<ReturnType<typeof engine.profile>>) => void = () => undefined;
    engine.profile.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const dayStart = Date.parse('2026-11-09T00:00:00.020Z');
    const dayEnd = Date.parse('2026-11-09T23:59:59.980Z');
    batch(archiveState('flights-bay-day', 'live', dayEnd));
    await waitFor(() => expect(screen.getByTestId('time-range').textContent).toBe('Data: Loading…'));
    const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
    act(() => answer({ rowCount: 1_456_777, columns: [{ name: 'ts', type: 'timestamp', duckdbType: 'TIMESTAMP', nullFraction: 0, distinctCount: 1_000, distinctApproximate: true, min: iso(dayStart), max: iso(dayEnd) }], engineMs: 1 } as never));
    await waitFor(() => expect(screen.getByTestId('time-range').textContent).toContain('00:00:00–23:59:59 UTC (24 h)'));
    expect(workspace.store.getState().time?.atMs).toBe(T);
    // "Load full day" gives its place to a note (the line does not move).
    expect(screen.queryByTestId('time-load-day')).toBeNull();
    expect(screen.getByTestId('time-day-loaded').textContent).toBe('Full day loaded');
  });

  it('a full day that fails to load (out of memory) says why, empties the views, and offers Retry and "Back to 30 minutes"', async () => {
    const { engine, live, workspace, batch, profile } = setup();
    await waitFor(() => expect(workspace.store.getState().maps).toHaveLength(1));
    batch(archiveState('flights-bay-30min', 'live'));
    await profile(START, END);
    fireEvent.click(screen.getByTestId('time-load-day'));
    await waitFor(() => expect(live.start).toHaveBeenLastCalledWith({ kind: 'archive', fixture: 'flights-bay-day' }));
    // The half hour's table is gone (no batch): the grid's count and the charts ask again.
    const counts = engine.count.mock.calls.length;
    batch(archiveState('flights-bay-day', 'connecting'));
    await waitFor(() => expect(engine.count.mock.calls.length).toBeGreaterThan(counts));
    const error = 'This file is too large for the web demo (Out of Memory Error: could not allocate block of size 256.0 KiB (976.4 MiB/976.5 MiB used))';
    const failed = archiveState('flights-bay-day', 'connecting');
    batch({ ...failed, feed: failed.feed && { ...failed.feed, status: 'stopped', failures: 1, error } });
    await waitFor(() => expect(screen.getByTestId('time-day-error').textContent).toMatch(/^The full day didn’t load: This file is too large/));
    expect(screen.getByTestId('time-day-error').getAttribute('role')).toBe('alert');
    expect(screen.getByTestId('map-map_1-status').textContent).toMatch(/^Didn’t load · This file is too large/);
    expect(screen.getByTestId('map-map_1-status').getAttribute('title')).toContain('976.5 MiB used');
    fireEvent.click(screen.getByTestId('time-load-day'));
    await waitFor(() => expect(live.start).toHaveBeenLastCalledWith({ kind: 'archive', fixture: 'flights-bay-day' }));
    fireEvent.click(screen.getByTestId('time-day-back'));
    await waitFor(() => expect(live.start).toHaveBeenLastCalledWith({ kind: 'archive', fixture: 'flights-bay-30min' }));
  });
});

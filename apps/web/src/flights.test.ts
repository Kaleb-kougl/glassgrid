import { describe, expect, it, vi } from 'vitest';
import { LIVE_FLIGHTS_FINGERPRINT, LIVE_FLIGHTS_HANDLE, LIVE_FLIGHTS_TABLE_ID, liveSourceConfigFromInput, type ParsedLiveSourceInput } from '@glassgrid/core';
import { createAppWorkspace } from '@glassgrid/app';
import type { WorkerEngine } from '@glassgrid/engine/web';
import { FLIGHTS_SAMPLE, flightsSourceFromSearch, initialFlightsSource } from './flights';
import { createDuckdbWebEngine } from './web-engine';
import { webMap } from './web-platform';

/*
 * The web demo's flights workspace (docs/live-flights-l3-data.md):
 * `?sample=flights` replays the fixture, `?live=1` polls the relay; either
 * opens a map and two charts over the live table.
 */

describe('flights links', () => {
  it('?sample=flights loads the 30-minute fixture whole (L4); ?live=1 polls the relay', () => {
    expect(flightsSourceFromSearch('?sample=flights')).toEqual({ source: 'archive', fixture: 'flights-bay-30min' });
    expect(flightsSourceFromSearch('?live=1')).toEqual({ source: 'live' });
    expect(flightsSourceFromSearch('?sample=taxi')).toBeNull();
    expect(flightsSourceFromSearch('?live=0')).toBeNull();
    expect(flightsSourceFromSearch('')).toBeNull();
  });

  it('?live=1 opens the recording instead once the person chose it in this tab (L5); other links are unaffected', () => {
    expect(initialFlightsSource('?live=1', null)).toEqual({ source: { source: 'live' }, requested: true });
    expect(initialFlightsSource('?live=1', 'recorded')).toEqual({ source: { source: 'archive', fixture: 'flights-bay-30min' }, requested: true });
    expect(initialFlightsSource('?sample=flights', 'recorded')).toEqual({ source: { source: 'archive', fixture: 'flights-bay-30min' }, requested: false });
    expect(initialFlightsSource('?sample=taxi', 'recorded')).toEqual({ source: null, requested: false });
  });

  it('the basemap is served under the base, with its credit', () => {
    expect(webMap('/')).toEqual({ assetsBase: '/map/', attribution: [] });
    expect(webMap('/glassgrid/')).toEqual({ assetsBase: '/glassgrid/map/', attribution: [] });
  });

  it('the start screen offers the flights sample; opening it loads the fixture and the workspace over flight_states', async () => {
    const workspace = createAppWorkspace();
    const started = vi.fn((input: unknown) => Promise.resolve(liveSourceConfigFromInput(input as ParsedLiveSourceInput)));
    workspace.registry.provide('startLive', started);
    const columns = [
      { name: 'ts', type: 'timestamp', duckdbType: 'TIMESTAMP' },
      { name: 'hex', type: 'text', duckdbType: 'VARCHAR' },
      { name: 'lat', type: 'decimal', duckdbType: 'DECIMAL(7,5)' },
      { name: 'lon', type: 'decimal', duckdbType: 'DECIMAL(8,5)' },
      { name: 'altBaroFt', type: 'integer', duckdbType: 'INTEGER' },
      { name: 'baroRateFpm', type: 'integer', duckdbType: 'INTEGER' },
      { name: 'category', type: 'text', duckdbType: 'VARCHAR' },
    ];
    const open = vi.fn(() => Promise.resolve({ table: { id: LIVE_FLIGHTS_TABLE_ID, file: LIVE_FLIGHTS_HANDLE, fileName: 'flight_states', fingerprint: LIVE_FLIGHTS_FINGERPRINT, usingParquetCache: false, columns }, engineMs: 1 }));
    const engine = { open, ready: new Promise(() => undefined) } as unknown as WorkerEngine;
    const onSampleOpened = vi.fn();
    const web = createDuckdbWebEngine({ registry: workspace.registry, engine, onSampleOpened });
    expect(web.samples?.map((sample) => sample.id)).toEqual(['taxi', 'retail', 'sensors', FLIGHTS_SAMPLE.id]);

    expect(await web.openSample?.('flights')).toEqual({ status: 'cancelled' });
    expect(started).toHaveBeenCalledWith({ source: 'archive', fixture: 'flights-bay-30min' }, expect.anything());
    expect(open).toHaveBeenCalledWith(LIVE_FLIGHTS_HANDLE);
    const state = workspace.store.getState();
    expect(state.dataSource?.handleId).toBe(LIVE_FLIGHTS_HANDLE);
    expect(state.maps.map((map) => map.spec.kind)).toEqual(['map']);
    expect(state.charts.map((chart) => `${chart.spec.mark} ${chart.spec.x.column}`)).toEqual(['histogram altBaroFt', 'bar category', 'histogram baroRateFpm']);
    expect(state.layout.cards.map((card) => card.chartId)).toEqual(['map_1', 'chart_2', 'chart_3', 'chart_4']);
    // The map filters the other views to its view (L4's default).
    expect(state.maps[0]?.filterToView).toBeUndefined();
    expect(onSampleOpened).toHaveBeenCalledWith(FLIGHTS_SAMPLE);
  });

  it('a feed that cannot start fails the open with a message and loads nothing', async () => {
    const workspace = createAppWorkspace();
    workspace.registry.provide('startLive', () => Promise.reject(new Error('Flight replays are not available in this app')));
    const engine = { open: vi.fn(), ready: new Promise(() => undefined) } as unknown as WorkerEngine;
    const web = createDuckdbWebEngine({ registry: workspace.registry, engine });
    expect(await web.openSample?.('flights')).toEqual({ status: 'failed', message: 'The flight data could not load: Flight replays are not available in this app' });
    expect(workspace.store.getState().dataSource).toBeNull();
  });
});

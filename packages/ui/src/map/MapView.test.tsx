import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import committed from '../../../../apps/web/public/map/basemap.json';
import { tokensFor } from '../tokens.js';
import { mapMaxBounds } from './mercator.js';
import type { MapAircraft, MapViewProps } from './types.js';

/*
 * MapView's wiring against a fake MapLibre (jsdom has no WebGL): what it
 * fetches, the style and layer it adds, and the contract's callbacks,
 * labels and credits. The drawing itself is covered by the E2E
 * (apps/web/e2e/map.spec.ts).
 */

const fake = vi.hoisted(() => {
  type Handler = (event: { point: { x: number; y: number } }) => void;
  interface Control {
    onAdd(map: FakeMap): HTMLElement;
    onRemove(map: FakeMap): void;
  }
  interface Layer {
    id: string;
    onRemove?(map: FakeMap, gl: unknown): void;
  }
  /**
   * As MapLibre 6.16 behaves where MapView depends on it: `remove()` calls
   * `onRemove` on every control and (through `setStyle(null)`) every custom
   * layer, then the map is dead: "you must not call any other methods on
   * the map", and the ones MapView uses throw (MapLibre's own `removeLayer`
   * and `addLayer` read a null style; `removeControl` calls the control's
   * `onRemove`, which reads a cleared `_map`). `hasControl` still answers.
   */
  class FakeMap {
    static last: FakeMap | null = null;
    readonly options: Record<string, unknown>;
    readonly handlers = new Map<string, Handler[]>();
    readonly layers: Layer[] = [];
    readonly controls: Control[] = [];
    readonly paint: [string, string, unknown][] = [];
    readonly canvas = document.createElement('canvas');
    removed = false;
    repaints = 0;
    /** Calls made after `remove()` (each also threw). */
    readonly callsAfterRemove: string[] = [];
    touchZoomRotate = { disableRotation: () => undefined };
    keyboard = { disableRotation: () => undefined };
    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.canvas.setAttribute('tabindex', '0');
      (options['container'] as HTMLElement).appendChild(this.canvas);
      FakeMap.last = this;
    }
    private alive(method: string) {
      if (!this.removed) return;
      this.callsAfterRemove.push(method);
      throw new TypeError(`FakeMap.${method}() after remove()`);
    }
    on(type: string, handler: Handler) {
      this.alive('on');
      this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
      return this;
    }
    off(type: string, handler: Handler) {
      this.alive('off');
      this.handlers.set(
        type,
        (this.handlers.get(type) ?? []).filter((h) => h !== handler),
      );
      return this;
    }
    fire(type: string, event: { point: { x: number; y: number } } = { point: { x: 0, y: 0 } }) {
      if (this.removed) return; // MapLibre's handlers are gone with the map
      for (const handler of this.handlers.get(type) ?? []) handler(event);
    }
    /** A plain linear projection: 1,000 px per degree from (−123, 38). */
    project([lon, lat]: [number, number]) {
      this.alive('project');
      return { x: (lon + 123) * 1000, y: (38 - lat) * 1000 };
    }
    getBounds() {
      this.alive('getBounds');
      return { getWest: () => -122.5, getSouth: () => 37.4, getEast: () => -122, getNorth: () => 37.8 };
    }
    getCanvas() {
      this.alive('getCanvas');
      return this.canvas;
    }
    addLayer(layer: Layer) {
      this.alive('addLayer');
      this.layers.push(layer);
    }
    removeLayer(id: string) {
      this.alive('removeLayer');
      const at = this.layers.findIndex((l) => l.id === id);
      if (at < 0) return;
      const [layer] = this.layers.splice(at, 1);
      layer?.onRemove?.(this, null);
    }
    getLayer(id: string) {
      this.alive('getLayer');
      return (this.options['style'] as { layers: { id: string }[] }).layers.find((l) => l.id === id);
    }
    setPaintProperty(layer: string, property: string, value: unknown) {
      this.alive('setPaintProperty');
      this.paint.push([layer, property, value]);
    }
    addControl(control: Control) {
      this.alive('addControl');
      this.controls.push(control);
      control.onAdd(this);
    }
    hasControl(control: Control) {
      return this.controls.includes(control);
    }
    removeControl(control: Control) {
      // As MapLibre: splice if present, then onRemove regardless (which throws on a removed control).
      const at = this.controls.indexOf(control);
      if (at > -1) this.controls.splice(at, 1);
      control.onRemove(this);
      this.alive('removeControl');
    }
    triggerRepaint() {
      this.alive('triggerRepaint');
      this.repaints += 1;
    }
    readonly maxBounds: unknown[] = [];
    setMaxBounds(bounds: unknown) {
      this.alive('setMaxBounds');
      this.maxBounds.push(bounds);
    }
    remove() {
      this.alive('remove');
      for (const control of this.controls) control.onRemove(this);
      this.controls.length = 0;
      for (const layer of this.layers.splice(0)) layer.onRemove?.(this, null);
      this.canvas.remove();
      this.removed = true;
    }
  }
  /** MapLibre's AttributionControl: `onRemove` reads `this._map.off`, which throws once it was removed. */
  class FakeAttribution {
    readonly options: { customAttribution?: string[] };
    _map: FakeMap | undefined;
    readonly container = document.createElement('div');
    constructor(options: { customAttribution?: string[] }) {
      this.options = options;
    }
    readonly update = () => undefined;
    onAdd(map: FakeMap) {
      this._map = map;
      map.on('styledata', this.update);
      return this.container;
    }
    onRemove() {
      this.container.remove();
      (this._map as FakeMap).off('styledata', this.update);
      this._map = undefined;
    }
  }
  const workerUrls: string[] = [];
  return { FakeMap, FakeAttribution, workerUrls, setWorkerUrl: (url: string) => workerUrls.push(url) };
});

vi.mock('maplibre-gl', () => ({ Map: fake.FakeMap, AttributionControl: fake.FakeAttribution, setWorkerUrl: fake.setWorkerUrl }));
vi.mock('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url', () => ({ default: '/assets/maplibre-gl-worker-test.js' }));

const { MapView, mapLabel } = await import('./MapView.js');

const T0 = Date.UTC(2026, 10, 9, 23, 27, 30);
const ac = (hex: string, lon: number, lat: number, flight: string | null = null): MapAircraft => ({
  hex,
  flight,
  typeCode: null,
  category: null,
  lat,
  lon,
  altBaroFt: 5_000,
  altGeomFt: null,
  onGround: false,
  gsKt: 0,
  trackDeg: 90,
  baroRateFpm: null,
  ts: T0,
});

function props(over: Partial<MapViewProps> = {}): MapViewProps {
  return {
    aircraft: [ac('a1', -122.4, 37.6, 'UAL1 '), ac('b2', -122.2, 37.7)],
    trails: [],
    dataClockMs: T0,
    playing: false,
    attribution: ['Aircraft data © adsb.lol contributors, ODbL 1.0'],
    theme: 'light',
    assetsBase: '/glassgrid/map/',
    ...over,
  };
}

const DESCRIPTOR_BOUNDS = committed.bounds as [number, number, number, number];
const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify(committed), { status: 200 })));

beforeEach(() => {
  fake.FakeMap.last = null;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function mounted(p: MapViewProps) {
  const view = render(<MapView {...p} />);
  await waitFor(() => expect(fake.FakeMap.last).not.toBeNull());
  const map = fake.FakeMap.last as InstanceType<typeof fake.FakeMap>;
  act(() => map.fire('load'));
  await waitFor(() => expect(screen.getByTestId('map-view').getAttribute('data-state')).toBe('ready'));
  return { view, map };
}

describe('MapView', () => {
  it('loads basemap.json from assetsBase, builds a same-origin style and adds the aircraft layer on load', async () => {
    const { map } = await mounted(props());
    expect(fetchMock).toHaveBeenCalledWith(`${window.location.origin}/glassgrid/map/basemap.json`, { credentials: 'same-origin' });
    const style = map.options['style'] as { glyphs: string; sources: Record<string, { data?: string }> };
    expect(style.glyphs).toBe(`${window.location.origin}/glassgrid/map/fonts/{fontstack}/{range}.pbf`);
    expect(style.sources['gg-basemap']?.data).toBe(`${window.location.origin}/glassgrid/map/basemap.geojson`);
    expect(map.options).toMatchObject({ center: [-122.25, 37.62], zoom: 8.6, attributionControl: false, maxPitch: 0 });
    expect(map.layers.map((l) => l.id)).toEqual(['gg-aircraft']);
    // Set once, at import, before any map exists: an absolute same-origin URL (never a blob).
    expect(fake.workerUrls).toEqual([`${window.location.origin}/assets/maplibre-gl-worker-test.js`]);
  });

  it('zooms out far enough to show all the data: the max bounds grow from the basemap to fit dataBounds, and follow it', async () => {
    const data = { west: -123.0, south: 37.0, east: -121.5, north: 38.5 };
    const { view, map } = await mounted(props({ dataBounds: data }));
    const [[west, south], [east, north]] = map.options['maxBounds'] as [[number, number], [number, number]];
    expect([west, south, east, north]).toEqual(mapMaxBounds(DESCRIPTOR_BOUNDS, data));
    expect(north - south).toBeGreaterThan(DESCRIPTOR_BOUNDS[3] - DESCRIPTOR_BOUNDS[1]);
    const calls = map.maxBounds.length;
    // The same box again (a new object): nothing to do.
    view.rerender(<MapView {...props({ dataBounds: { ...data } })} />);
    expect(map.maxBounds).toHaveLength(calls);
    const other = { west: -122.6, south: 37.5, east: -122.2, north: 37.9 };
    view.rerender(<MapView {...props({ dataBounds: other })} />);
    const [w, s, e, n] = mapMaxBounds(DESCRIPTOR_BOUNDS, other);
    expect(map.maxBounds.at(-1)).toEqual([
      [w, s],
      [e, n],
    ]);
  });

  it('names the canvas with the aircraft count and the selected callsign', async () => {
    const { view, map } = await mounted(props());
    expect(map.canvas.getAttribute('aria-label')).toBe(mapLabel(2, null));
    expect(map.canvas.getAttribute('aria-label')).toMatch(/^Live flights map, 2 aircraft\./);
    view.rerender(<MapView {...props({ selectedHex: 'a1' })} />);
    expect(map.canvas.getAttribute('aria-label')).toMatch(/2 aircraft, UAL1 selected\./);
    expect(map.canvas.getAttribute('tabindex')).toBe('0');
  });

  it('takes the selected aircraft’s track (L4): only its points count, and without one it draws none', async () => {
    const { view } = await mounted(props());
    expect(screen.getByTestId('map-view').getAttribute('data-track')).toBe('0');
    const track = [
      { hex: 'a1', ts: T0 - 60_000, lat: 37.5, lon: -122.5, altBaroFt: 1_000 },
      { hex: 'a1', ts: T0 - 30_000, lat: 37.55, lon: -122.45, altBaroFt: 3_000 },
      { hex: 'b2', ts: T0 - 30_000, lat: 37.7, lon: -122.2, altBaroFt: 3_000 },
    ];
    view.rerender(<MapView {...props({ selectedHex: 'a1', selectedTrack: track })} />);
    expect(screen.getByTestId('map-view').getAttribute('data-track')).toBe('2');
    view.rerender(<MapView {...props({ selectedHex: null, selectedTrack: track })} />);
    expect(screen.getByTestId('map-view').getAttribute('data-track')).toBe('0');
  });

  it('selects the aircraft under a click, nothing elsewhere, and clears on Escape', async () => {
    const onSelect = vi.fn();
    const { view, map } = await mounted(props({ onSelect }));
    act(() => map.fire('click', { point: { x: 603, y: 398 } })); // a1 projects to (600, 400)
    expect(onSelect).toHaveBeenLastCalledWith('a1');
    act(() => map.fire('click', { point: { x: 100, y: 100 } }));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    view.rerender(<MapView {...props({ onSelect, selectedHex: 'b2' })} />);
    onSelect.mockClear();
    map.canvas.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('reports the viewport 200 ms after a move ends (and once after load)', async () => {
    const onViewportChange = vi.fn();
    const { map } = await mounted(props({ onViewportChange }));
    await waitFor(() => expect(onViewportChange).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    act(() => {
      map.fire('moveend');
      map.fire('moveend');
    });
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(onViewportChange).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onViewportChange).toHaveBeenCalledTimes(2);
    expect(onViewportChange).toHaveBeenLastCalledWith({ west: -122.5, south: 37.4, east: -122, north: 37.8 });
  });

  it('credits the props attribution as escaped text, replaced when it changes', async () => {
    const { view, map } = await mounted(props({ attribution: ['Data © <adsb.lol>'] }));
    expect((map.controls[0] as InstanceType<typeof fake.FakeAttribution>).options.customAttribution).toEqual(['Data © &#60;adsb.lol&#62;']);
    view.rerender(<MapView {...props({ attribution: ['A', 'B'] })} />);
    expect(map.controls).toHaveLength(1);
    expect((map.controls[0] as InstanceType<typeof fake.FakeAttribution>).options.customAttribution).toEqual(['A', 'B']);
  });

  it('repaints the basemap from the dark tokens in place when the theme changes', async () => {
    const { view, map } = await mounted(props());
    view.rerender(<MapView {...props({ theme: 'dark' })} />);
    expect(map.paint).toContainEqual(['gg-land', 'fill-color', tokensFor('dark').map.land]);
    expect(screen.getByTestId('map-view').getAttribute('data-gg-theme')).toBe('dark');
  });

  it('refuses a basemap on another origin without fetching it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<MapView {...props({ assetsBase: 'https://tiles.example.com/map/' })} />);
    await waitFor(() => expect(screen.getByTestId('map-view').getAttribute('data-state')).toBe('error'));
    expect(screen.getByRole('status').textContent).toMatch(/must be on this site/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('removes the map on unmount', async () => {
    const { view, map } = await mounted(props());
    view.unmount();
    expect(map.removed).toBe(true);
  });

  it('unmounts without touching the removed map: controls and the aircraft layer go with it, nothing throws', async () => {
    const { view, map } = await mounted(props({ playing: true, speed: 1 }));
    expect(map.controls).toHaveLength(1);
    expect(map.layers).toHaveLength(1);
    const control = map.controls[0] as InstanceType<typeof fake.FakeAttribution>;
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.error);
    window.addEventListener('error', onError);
    try {
      expect(() => view.unmount()).not.toThrow();
      // A frame or timer that was already scheduled must not reach the map either.
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      window.removeEventListener('error', onError);
    }
    expect(errors).toEqual([]);
    expect(map.removed).toBe(true);
    expect(map.callsAfterRemove).toEqual([]);
    expect(control._map).toBeUndefined();
    expect(map.controls).toHaveLength(0);
    expect(map.layers).toHaveLength(0);
  });

  it('a new assets base replaces the map without calling the old one after its removal', async () => {
    const { view, map } = await mounted(props({ playing: true, speed: 1 }));
    // New rows, theme and credits in the same render as the new base: every effect reruns around the swap.
    view.rerender(<MapView {...props({ playing: true, speed: 1, assetsBase: '/map/', theme: 'dark', attribution: ['X'], aircraft: [ac('c3', -122.3, 37.5)] })} />);
    await waitFor(() => expect(fake.FakeMap.last).not.toBe(map));
    const next = fake.FakeMap.last as InstanceType<typeof fake.FakeMap>;
    act(() => next.fire('load'));
    await waitFor(() => expect(screen.getByTestId('map-view').getAttribute('data-state')).toBe('ready'));
    expect(map.removed).toBe(true);
    expect(map.callsAfterRemove).toEqual([]);
    expect(next.controls).toHaveLength(1);
    expect((next.controls[0] as InstanceType<typeof fake.FakeAttribution>).options.customAttribution).toEqual(['X']);
    view.unmount();
    expect(next.callsAfterRemove).toEqual([]);
  });
});

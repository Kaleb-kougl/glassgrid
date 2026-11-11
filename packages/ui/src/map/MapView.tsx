/// <reference types="vite/client" />
import 'maplibre-gl/dist/maplibre-gl.css';
import './map.css';
import { AttributionControl, Map as MapLibreMap, setWorkerUrl } from 'maplibre-gl';
// MapLibre's worker as a same-origin module script emitted by Vite: under `worker-src 'self'` it may
// not start from a blob: URL, which is what MapLibre does with a worker URL on another origin.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { AircraftLayer } from './aircraft-layer.js';
import { assetUrl, DESCRIPTOR_FILE, parseDescriptor, resolveAssetsBase } from './basemap.js';
import { pickNearest } from './hit.js';
import { mapMaxBounds } from './mercator.js';
import { AircraftScene } from './scene.js';
import { buildStyle, creditHtml, themePaint } from './style.js';
import type { MapBounds, MapViewProps } from './types.js';

/*
 * The live-flights map (milestone L3): MapLibre GL JS over the self-hosted
 * basemap in `assetsBase` (apps/web/public/map/), with the aircraft and
 * their trails in a custom WebGL layer (aircraft-layer.ts) and the motion
 * between fixes from dead-reckoning.ts. This module is the lazy chunk:
 * `loadMapView()` (index.ts) imports it, MapLibre and its CSS with it.
 * Contract and notes: docs/live-flights-l3-map.md.
 */

setWorkerUrl(new URL(maplibreWorkerUrl, document.baseURI).href);

const DEFAULT_CENTER: [number, number] = [-122.25, 37.62];
const DEFAULT_ZOOM = 8.6;
const VIEWPORT_DEBOUNCE_MS = 200;

type Status = 'loading' | 'ready' | 'error';
type PaintProperty = Parameters<MapLibreMap['setPaintProperty']>[1];

/**
 * Maps this component has removed. After `remove()` MapLibre says no other
 * method may be called: `remove()` has already called `onRemove` on every
 * control and custom layer, so a later `removeControl` throws (the
 * attribution control reads its cleared `_map`) and `addLayer` reads a null
 * style. React runs the map effect's cleanup before the other effects' (and
 * an effect may rerun with the old map in the render that swaps it), so each
 * of them checks here first.
 */
const removedMaps = new WeakSet<MapLibreMap>();

function usable(map: MapLibreMap | null): map is MapLibreMap {
  return map !== null && !removedMaps.has(map);
}

function boundsOf(map: MapLibreMap): MapBounds {
  const b = map.getBounds();
  return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
}

/** The canvas's accessible name: the aircraft count, and the selected one. */
export function mapLabel(count: number, selected: string | null): string {
  const n = `${count.toLocaleString('en-US')} aircraft`;
  return `Live flights map, ${n}${selected ? `, ${selected} selected` : ''}. Arrow keys pan, plus and minus zoom.`;
}

export function MapView(props: MapViewProps): ReactElement {
  const { aircraft, trails, dataClockMs, playing, speed, attribution, selectedHex, selectedTrack, theme, assetsBase } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef(props);
  const [scene] = useState(() => new AircraftScene(theme, performance.now()));
  const [map, setMap] = useState<MapLibreMap | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [message, setMessage] = useState<string | null>(null);
  /** The basemap's box, once its descriptor is read (the max bounds grow from it to fit `dataBounds`). */
  const basemapBounds = useRef<readonly [number, number, number, number] | null>(null);

  useEffect(() => {
    propsRef.current = props;
  });

  // The map itself: once per assets base.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let created: MapLibreMap | null = null;
    let viewportTimer: ReturnType<typeof setTimeout> | null = null;
    let hoverFrame = 0;
    let onKeyDown: ((event: KeyboardEvent) => void) | null = null;
    const fail = (text: string, error: unknown) => {
      if (cancelled) return;
      console.warn(`[glassgrid] map: ${text}`, error);
      setStatus('error');
      setMessage(text);
    };
    setStatus('loading');
    setMessage(null);
    let base: URL;
    try {
      base = resolveAssetsBase(assetsBase, window.location.href);
    } catch (error) {
      fail('The map is unavailable: its files must be on this site.', error);
      return;
    }
    fetch(assetUrl(DESCRIPTOR_FILE, base), { credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${response.url}`);
        return parseDescriptor(await response.json());
      })
      .then((descriptor) => {
        if (cancelled) return;
        const initial = propsRef.current;
        basemapBounds.current = descriptor.bounds;
        const [west, south, east, north] = mapMaxBounds(descriptor.bounds, initial.dataBounds);
        const m = new MapLibreMap({
          container,
          style: buildStyle(descriptor, base, initial.theme),
          center: initial.initialView?.center ?? DEFAULT_CENTER,
          zoom: initial.initialView?.zoom ?? DEFAULT_ZOOM,
          minZoom: 7,
          maxZoom: 16,
          maxBounds: [
            [west, south],
            [east, north],
          ],
          renderWorldCopies: false,
          dragRotate: false,
          pitchWithRotate: false,
          touchPitch: false,
          maxPitch: 0,
          attributionControl: false,
          fadeDuration: 0,
        });
        created = m;
        m.touchZoomRotate.disableRotation();
        m.keyboard.disableRotation();
        const layer = new AircraftLayer(scene, { onError: (error) => fail('Aircraft cannot be drawn: this browser has no WebGL2.', error) });
        const emitViewport = () => {
          if (viewportTimer !== null) clearTimeout(viewportTimer);
          viewportTimer = setTimeout(() => {
            viewportTimer = null;
            if (!cancelled) propsRef.current.onViewportChange?.(boundsOf(m));
          }, VIEWPORT_DEBOUNCE_MS);
        };
        const aircraftAt = (x: number, y: number): string | null => {
          const now = performance.now();
          const points = scene.placements(now).map((p) => {
            const s = m.project([p.lon, p.lat]);
            return { hex: p.hex, x: s.x, y: s.y };
          });
          return pickNearest(points, x, y);
        };
        m.on('load', () => {
          if (cancelled) return;
          m.addLayer(layer);
          setStatus((current) => (current === 'error' ? current : 'ready'));
          emitViewport();
        });
        m.on('moveend', emitViewport);
        m.on('click', (event) => {
          propsRef.current.onSelect?.(aircraftAt(event.point.x, event.point.y));
        });
        m.on('mousemove', (event) => {
          if (hoverFrame) return;
          const { x, y } = event.point;
          hoverFrame = requestAnimationFrame(() => {
            hoverFrame = 0;
            if (!cancelled) m.getCanvas().style.cursor = aircraftAt(x, y) ? 'pointer' : '';
          });
        });
        m.on('webglcontextlost', () => layer.contextLost());
        m.on('error', (event) => console.warn('[glassgrid] map:', event.error));
        onKeyDown = (event) => {
          if (event.key === 'Escape' && propsRef.current.selectedHex) propsRef.current.onSelect?.(null);
        };
        m.getCanvas().addEventListener('keydown', onKeyDown);
        setMap(m);
      })
      .catch((error: unknown) => fail('The map could not start.', error));
    return () => {
      cancelled = true;
      if (viewportTimer !== null) clearTimeout(viewportTimer);
      if (hoverFrame) cancelAnimationFrame(hoverFrame);
      if (created) {
        if (onKeyDown) created.getCanvas().removeEventListener('keydown', onKeyDown);
        // MapLibre's remove() takes the controls (onRemove), the aircraft layer (onRemove), its listeners, its
        // ResizeObserver and the WebGL context with it; nothing may call the map after this (see `usable`).
        removedMaps.add(created);
        created.remove();
      }
      setMap(null);
    };
  }, [assetsBase, scene]);

  // The data's extent, when it changes (another table, a profile): the max bounds follow it.
  const dataBounds = props.dataBounds;
  const dataBoundsKey = dataBounds === undefined ? '' : `${dataBounds.west},${dataBounds.south},${dataBounds.east},${dataBounds.north}`;
  useEffect(() => {
    const basemap = basemapBounds.current;
    if (!usable(map) || basemap === null) return;
    const [west, south, east, north] = mapMaxBounds(basemap, propsRef.current.dataBounds);
    map.setMaxBounds([
      [west, south],
      [east, north],
    ]);
  }, [map, dataBoundsKey]);

  // Rows, playback, selection, theme: into the scene; a repaint shows them.
  useEffect(() => {
    scene.setData(aircraft, trails, dataClockMs, performance.now());
    if (usable(map)) map.triggerRepaint();
  }, [scene, map, aircraft, trails, dataClockMs]);

  useEffect(() => {
    scene.setPlayback(playing, speed, performance.now());
    if (usable(map)) map.triggerRepaint();
  }, [scene, map, playing, speed]);

  useEffect(() => {
    scene.setSelected(selectedHex);
    scene.setTrack(selectedTrack);
    if (usable(map)) map.triggerRepaint();
  }, [scene, map, selectedHex, selectedTrack]);

  useEffect(() => {
    scene.setTheme(theme);
    if (!usable(map) || status !== 'ready') return;
    for (const [layer, paint] of Object.entries(themePaint(theme))) {
      if (!map.getLayer(layer)) continue;
      for (const [property, value] of Object.entries(paint)) map.setPaintProperty(layer, property as PaintProperty, value);
    }
    map.triggerRepaint();
  }, [scene, map, status, theme]);

  // Credits: the props' attribution, then the basemap's (its source carries them).
  const attributionKey = attribution.join('\n');
  useEffect(() => {
    if (!usable(map)) return;
    const control = new AttributionControl({ customAttribution: attributionKey === '' ? [] : attributionKey.split('\n').map((text) => creditHtml(text)) });
    map.addControl(control, 'bottom-right');
    return () => {
      // After map.remove() the control is already gone (and removing it again throws).
      if (usable(map) && map.hasControl(control)) map.removeControl(control);
    };
  }, [map, attributionKey]);

  // The accessible name follows the aircraft count and the selection.
  const selectedLabel = selectedHex ? (aircraft.find((a) => a.hex === selectedHex)?.flight?.trim() ?? selectedHex) : null;
  const label = mapLabel(aircraft.length, selectedLabel || null);
  useEffect(() => {
    if (usable(map)) map.getCanvas().setAttribute('aria-label', label);
  }, [map, label]);

  // Animation: one repaint per frame while playing (or easing to new rows), and only while the tab is visible.
  useEffect(() => {
    if (!usable(map)) return;
    let frame = 0;
    let stopped = false;
    const tick = () => {
      frame = 0;
      if (stopped || !usable(map)) return;
      map.triggerRepaint();
      if (document.visibilityState === 'visible' && scene.isAnimating(performance.now())) frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (frame === 0 && !stopped && usable(map) && document.visibilityState === 'visible' && scene.isAnimating(performance.now())) frame = requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') start();
      else if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [map, scene, playing, speed, aircraft, trails, dataClockMs]);

  // How many points of the selected track were given (E2E and tests read it; the layer thins them further).
  const trackPoints = selectedHex && selectedTrack ? selectedTrack.reduce((n, point) => (point.hex === selectedHex ? n + 1 : n), 0) : 0;
  return (
    <div className="gg-map" data-gg-theme={theme} data-testid="map-view" data-state={status} data-aircraft={aircraft.length} data-track={trackPoints}>
      <div ref={containerRef} className="gg-map__canvas" />
      {message ? (
        <p className="gg-map__message" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

export default MapView;

import { AltitudeLegend, loadMapView, mapRenderStats, resetMapRenderStats, type MapBounds, type MapTrailPoint, type MapViewProps } from '@glassgrid/ui/map';
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactElement } from 'react';
import { withBase } from '../base';
import { DEMO_START_MS, SyntheticTraffic, type Snapshot } from './synthetic';

/*
 * `?map-demo`: the live-flights map on synthetic traffic, for the map's E2E
 * (map.spec.ts: CSP, canvas, selection) and its benchmark (map-perf.spec.ts).
 * Not linked from the app; the real wiring lives in @glassgrid/app.
 *
 * Query parameters: `theme=light|dark` (default light), `n` (aircraft,
 * default 183), `paused` (start paused), `speed` (default 1), `poll` (seconds
 * between synthetic polls, default 10), `center=lon,lat` and `zoom` (the
 * initial view; default the component's), `trails=0` (no trails).
 */

export interface MapDemoHooks {
  readonly stats: typeof mapRenderStats;
  readonly resetStats: typeof resetMapRenderStats;
  selected: string | null;
  viewport: MapBounds | null;
  polls: number;
  aircraft: number;
}

declare global {
  interface Window {
    __ggMapDemo?: MapDemoHooks;
  }
}

const ATTRIBUTION = ['Synthetic aircraft (test data)'];
const NO_TRAILS: readonly MapTrailPoint[] = [];

export function MapDemo({ search }: { readonly search: string }): ReactElement {
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const n = Math.max(1, Math.min(5_000, Number(params.get('n') ?? 183) || 183));
  const pollMs = Math.max(1, Number(params.get('poll') ?? 10) || 10) * 1_000;
  const speed = Number(params.get('speed') ?? 1) || 1;
  const showTrails = params.get('trails') !== '0';
  const initialView = useMemo(() => {
    const center = (params.get('center') ?? '').split(',').map(Number);
    const zoom = Number(params.get('zoom'));
    if (center.length !== 2 || !center.every(Number.isFinite) || !Number.isFinite(zoom) || params.get('zoom') === null) return undefined;
    return { center: [center[0] as number, center[1] as number] as [number, number], zoom };
  }, [params]);
  const [traffic] = useState(() => new SyntheticTraffic(n));
  const [theme, setTheme] = useState<'light' | 'dark'>(params.get('theme') === 'dark' ? 'dark' : 'light');
  const [playing, setPlaying] = useState(!params.has('paused'));
  const [selected, setSelected] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => traffic.snapshot(DEMO_START_MS));
  const [View, setView] = useState<ComponentType<MapViewProps> | null>(null);
  // What the E2E and the benchmark read (window.__ggMapDemo); mutable on purpose.
  const hooks = useRef<MapDemoHooks>({ stats: mapRenderStats, resetStats: resetMapRenderStats, selected: null, viewport: null, polls: 1, aircraft: traffic.size });

  useEffect(() => {
    window.__ggMapDemo = hooks.current;
    let live = true;
    void loadMapView().then((component) => {
      if (live) setView(() => component);
    });
    return () => {
      live = false;
    };
  }, []);

  // A synthetic poll every `poll` seconds of wall time while playing; the data clock advances by speed × that.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      setSnapshot((previous) => {
        hooks.current.polls += 1;
        return traffic.snapshot(previous.dataClockMs + pollMs * speed);
      });
    }, pollMs);
    return () => clearInterval(timer);
  }, [playing, pollMs, speed, traffic]);

  const onSelect = (hex: string | null) => {
    hooks.current.selected = hex;
    setSelected(hex);
  };
  const onViewportChange = (bounds: MapBounds) => {
    hooks.current.viewport = bounds;
  };
  const selectedFlight = selected ? (snapshot.aircraft.find((a) => a.hex === selected)?.flight ?? selected) : 'none';

  return (
    <div className="map-demo" data-gg-theme={theme}>
      <header className="map-demo__bar">
        <h1 className="map-demo__title">Map test page</h1>
        <button type="button" data-testid="map-demo-play" onClick={() => setPlaying((p) => !p)}>
          {playing ? 'Pause' : 'Play'}
        </button>
        <button type="button" data-testid="map-demo-theme" onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}>
          {theme === 'light' ? 'Dark' : 'Light'} theme
        </button>
        <span data-testid="map-demo-selected">Selected: {selectedFlight}</span>
        <AltitudeLegend theme={theme} className="map-demo__legend" />
      </header>
      <main className="map-demo__map">
        {View ? (
          <View
            aircraft={snapshot.aircraft}
            trails={showTrails ? snapshot.trails : NO_TRAILS}
            dataClockMs={snapshot.dataClockMs}
            playing={playing}
            speed={speed}
            attribution={ATTRIBUTION}
            onSelect={onSelect}
            onViewportChange={onViewportChange}
            selectedHex={selected}
            theme={theme}
            assetsBase={withBase('map/')}
            {...(initialView ? { initialView } : {})}
          />
        ) : (
          <p data-testid="map-demo-loading">Loading the map…</p>
        )}
      </main>
    </div>
  );
}

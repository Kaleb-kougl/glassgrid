import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { MapAircraftRow, MapSpec, MapTrailRow, MapViewState, TableId } from '@glassgrid/core';
import { Button } from '@glassgrid/ui';
import { AltitudeLegend, loadMapView, type MapBounds, type MapViewProps } from '@glassgrid/ui/map';
import type { EngineClientLike } from '../engine';
import { feedStatusLine, type MapClock } from '../flights';
import type { PlatformMap } from '../platform';
import { AircraftDetails, aircraftName } from './AircraftDetails';
import { MapBoundary } from './MapBoundary';
import { useMapData, useMapTrack, type MapSnapshot } from './map-data';

/*
 * A map view card (docs/live-flights-l3-data.md): the MapLibre component
 * from `@glassgrid/ui/map`, loaded as a lazy chunk the first time a map
 * shows, fed one consistent snapshot (aircraft, trails and the clock they
 * were computed for) by `useMapData`.
 */

type MapComponent = ComponentType<MapViewProps>;

/** Before the first snapshot: the same empty arrays every render (a new array is "new rows" to the map). */
const NO_AIRCRAFT: readonly MapAircraftRow[] = Object.freeze([]);
const NO_TRAILS: readonly MapTrailRow[] = Object.freeze([]);
const NO_TRACK: readonly MapTrailRow[] = Object.freeze([]);

/** Wall-clock time, ticking every second while `enabled` (a backing-off feed's countdown). */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1_000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [enabled]);
  return now;
}

let component: Promise<MapComponent> | null = null;

/** The map component, loaded once per page (a lazy chunk). A failed load is retried on the next mount. */
function useMapComponent(enabled: boolean): { component: MapComponent | null; error: string | null } {
  const [loaded, setLoaded] = useState<{ component: MapComponent | null; error: string | null }>({ component: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    component ??= loadMapView();
    component.then(
      (resolved) => {
        if (live) setLoaded({ component: resolved, error: null });
      },
      (error: unknown) => {
        component = null;
        if (live) setLoaded({ component: null, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [enabled]);
  return loaded;
}

export interface MapCardProps {
  engine: Pick<EngineClientLike, 'mapQuery'>;
  tableId: TableId | null;
  map: MapViewState;
  /** The spec as queried: the map's own filters followed by every view's selection and the user filters. */
  spec: MapSpec;
  /** Bumped when the table's data changed under the same spec (a live batch, type overrides, an engine restart). */
  dataVersion: number;
  clock: MapClock;
  theme: 'light' | 'dark';
  /** The shell's basemap; without it the card says maps are not available here. */
  platformMap: PlatformMap | undefined;
  selectedHex: string | null;
  onSelect: (hex: string | null) => void;
  onViewportChange: (mapId: string, bounds: MapBounds) => void;
  /** Each new snapshot's aircraft (null when the card goes), so the app can drop a selection no map shows. */
  onAircraft?: ((mapId: string, aircraft: readonly MapAircraftRow[] | null) => void) | undefined;
  /**
   * A snapshot reached the screen (the frame after the component got it): its spec as JSON (what the
   * cross-filter timing compares) and its data clock (what a seek's timing waits for).
   */
  onPainted?: ((mapId: string, specKey: string, dataClockMs: number, engineMs: number) => void) | undefined;
  /** "Filter to map view" switched (L4). */
  onFilterToView?: ((mapId: string, enabled: boolean) => void) | undefined;
  /** Shown above the map (L4: the time scrubber, on the first map card). */
  toolbar?: ReactNode;
  onRemove: () => void;
  position: { index: number; count: number };
}

export function MapCard({
  engine,
  tableId,
  map,
  spec,
  dataVersion,
  clock,
  theme,
  platformMap,
  selectedHex,
  onSelect,
  onViewportChange,
  onAircraft,
  onPainted,
  onFilterToView,
  toolbar,
  onRemove,
  position,
}: MapCardProps) {
  const data = useMapData(engine, tableId, map.id, spec, clock.dataClockMs, dataVersion);
  const track = useMapTrack(engine, tableId, map.id, spec, clock.dataClockMs, dataVersion, selectedHex);
  const trackSnapshot = track.status === 'ready' ? track.snapshot : track.status === 'loading' ? track.previous : null;
  const { component: View, error: loadError } = useMapComponent(platformMap !== undefined);
  const snapshot = data.status === 'ready' ? data.snapshot : data.status === 'idle' ? null : data.previous;
  const title = map.title ?? 'Map';
  const attribution = [...(clock.attribution === null ? [] : [clock.attribution]), ...(platformMap?.attribution ?? [])];
  const ready: MapSnapshot | null = data.status === 'ready' ? data.snapshot : null;
  const mapId = map.id;
  useEffect(() => {
    if (ready !== null) onAircraft?.(mapId, ready.aircraft);
  }, [ready, mapId, onAircraft]);
  useEffect(() => () => onAircraft?.(mapId, null), [mapId, onAircraft]);
  // Painted: the frame after the component got the snapshot (MapLibre repaints in the frame its effect asked for,
  // which runs before this one's callback).
  useEffect(() => {
    if (ready === null || onPainted === undefined) return;
    const frame = requestAnimationFrame(() => onPainted(mapId, ready.specKey, ready.dataClockMs, ready.engineMs));
    return () => cancelAnimationFrame(frame);
  }, [ready, mapId, onPainted]);
  const feed = clock.feed;
  const now = useNow(feed?.status === 'backoff' && feed.nextAttemptAt !== null);

  let body;
  if (platformMap === undefined) {
    body = <p className="map-card__note">Maps are not available in this app yet.</p>;
  } else if (loadError !== null) {
    body = (
      <p className="map-card__note" role="alert">
        The map could not be loaded: {loadError}
      </p>
    );
  } else if (View === null) {
    body = (
      <p className="map-card__note" role="status" data-testid={`map-${map.id}-loading`}>
        Loading map…
      </p>
    );
  } else {
    body = (
      <View
        aircraft={snapshot?.aircraft ?? NO_AIRCRAFT}
        trails={snapshot?.trails ?? NO_TRAILS}
        dataClockMs={snapshot?.dataClockMs ?? clock.dataClockMs ?? 0}
        playing={clock.playing}
        {...(clock.speed === undefined ? {} : { speed: clock.speed })}
        {...(clock.initialView === undefined ? {} : { initialView: clock.initialView })}
        {...(clock.dataBounds === undefined ? {} : { dataBounds: clock.dataBounds })}
        attribution={attribution}
        onViewportChange={(bounds) => onViewportChange(map.id, bounds)}
        onSelect={onSelect}
        selectedHex={selectedHex}
        selectedTrack={trackSnapshot?.hex === selectedHex ? trackSnapshot.points : NO_TRACK}
        theme={theme}
        assetsBase={platformMap.assetsBase}
      />
    );
  }

  // The line: a query error; else the live feed's state (L2) and the aircraft count. The feed's state also goes to a
  // polite live region, without the countdown, so a change of state is announced once.
  const count = snapshot === null ? (clock.dataClockMs === null ? null : 'Loading…') : `${snapshot.aircraft.length.toLocaleString('en-US')} aircraft`;
  const feedLine = feed === undefined ? null : feedStatusLine(feed, clock.speed, now);
  let status: string;
  if (data.status === 'error') status = data.message;
  else if (feedLine !== null) status = count === null ? feedLine.text : `${feedLine.text} · ${count}`;
  else status = count ?? 'Waiting for data…';
  const legend = View !== null && platformMap !== undefined && loadError === null;
  const selected = selectedHex === null ? undefined : snapshot?.aircraft.find((aircraft) => aircraft.hex === selectedHex);
  const filterOn = map.filterToView !== false;
  const announce = selected === undefined ? '' : `Selected ${aircraftName(selected)}`;
  return (
    <section
      className="map-card"
      aria-label={`${title}, map, ${position.index + 1} of ${position.count}`}
      data-testid={`map-${map.id}`}
      data-status={data.status}
      data-aircraft={snapshot?.aircraft.length}
      data-clock={snapshot?.dataClockMs}
      data-filter={filterOn ? 'on' : 'off'}
    >
      <header className="map-card__header">
        <h3 className="map-card__title">{title}</h3>
        <span
          className="map-card__status"
          role={data.status === 'error' ? 'alert' : undefined}
          title={feed?.error ? `${status}\n${feed.error}` : status}
          data-testid={`map-${map.id}-status`}
          data-feed={feed === undefined ? undefined : (feed?.status ?? 'none')}
        >
          {status}
        </span>
        {feedLine !== null && (
          <span className="gg-visually-hidden" aria-live="polite" aria-atomic="true" data-testid={`map-${map.id}-feed`}>
            {`${title}: ${feedLine.announce}`}
          </span>
        )}
        <span className="panel__spacer" />
        {onFilterToView && (
          <label className="map-card__filter" title="Charts and the grid show only what is inside the map's view">
            <input type="checkbox" checked={filterOn} onChange={(event) => onFilterToView(map.id, event.target.checked)} data-testid={`map-${map.id}-filter`} />
            Filter to map view
          </label>
        )}
        <Button variant="ghost" size="sm" onClick={onRemove} aria-label={`Remove ${title}`} data-testid={`map-${map.id}-remove`}>
          Remove
        </Button>
      </header>
      {toolbar}
      <span className="gg-visually-hidden" aria-live="polite" aria-atomic="true" data-testid={`map-${map.id}-selection`}>
        {announce}
      </span>
      <div className="map-card__view">
        <MapBoundary
          fallback={(error, retry) => (
            <div className="map-card__note" role="alert" data-testid={`map-${map.id}-failed`}>
              <p className="map-card__failed">The map stopped working: {error.message}</p>
              <Button variant="secondary" size="sm" onClick={retry}>
                Restart the map
              </Button>
            </div>
          )}
        >
          {body}
          {legend && <AltitudeLegend theme={theme} className="map-card__legend" label={`${title}: aircraft altitude`} />}

        </MapBoundary>
      </div>
      {legend && selected !== undefined && clock.dataClockMs !== null && (
        <AircraftDetails
          aircraft={selected}
          atMs={clock.dataClockMs}
          trackPoints={trackSnapshot?.hex === selectedHex ? trackSnapshot.points.length : null}
          onClose={() => onSelect(null)}
          testId={`map-${map.id}-details`}
        />
      )}
    </section>
  );
}

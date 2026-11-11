import { useCallback, useLayoutEffect, useRef } from 'react';
import type { MapBounds } from '@glassgrid/ui/map';

/*
 * Each map view's viewport, as the map component reports it after a pan or
 * zoom (200 ms after `moveend`, and once when it has loaded). Since L4
 * (docs/live-flights-l4.md) it is the map's selection: `onReport` records
 * it in the workspace (`setMapViewport`, no undo entry), and while the
 * map's "Filter to map view" is on every other view filters by it.
 *
 * The last report per map is also kept here, in a ref (panning must not
 * re-render the app by itself): it is what the camera shows, so when the
 * workspace's copy differs (an undo restored an older one with a removed
 * map's neighbours) the app records it again (`stale`).
 */
export function useMapViewport(onReport: (mapId: string, bounds: MapBounds) => void): {
  readonly viewports: ReadonlyMap<string, MapBounds>;
  readonly onViewportChange: (mapId: string, bounds: MapBounds) => void;
  /** Forget maps that are gone (their next mount reports again). */
  readonly keep: (mapIds: readonly string[]) => void;
} {
  const viewports = useRef(new Map<string, MapBounds>());
  const report = useRef(onReport);
  useLayoutEffect(() => {
    report.current = onReport;
  });
  const onViewportChange = useCallback((mapId: string, bounds: MapBounds) => {
    viewports.current.set(mapId, bounds);
    report.current(mapId, bounds);
  }, []);
  const keep = useCallback((mapIds: readonly string[]) => {
    for (const id of [...viewports.current.keys()]) if (!mapIds.includes(id)) viewports.current.delete(id);
  }, []);
  return { viewports: viewports.current, onViewportChange, keep };
}

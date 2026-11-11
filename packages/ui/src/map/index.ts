import type { ComponentType } from 'react';
import type { MapViewProps } from './types.js';

/*
 * `@glassgrid/ui/map`: the live-flights map's contract and its loader.
 * Nothing here imports MapLibre: `loadMapView()` fetches the component, and
 * MapLibre (JS, CSS and its worker) with it, as a separate lazy chunk.
 */

export type { MapAircraft, MapBounds, MapTrailPoint, MapViewProps } from './types.js';
export { ALTITUDE_BANDS, altitudeClass, altitudeFt, altitudeLegend, type AltitudeBand, type AltitudeClass, type LegendEntry } from './altitude.js';
export { AltitudeLegend, type AltitudeLegendProps } from './AltitudeLegend.js';
export { mapRenderStats, resetMapRenderStats, type MapRenderStats } from './stats.js';

let loading: Promise<ComponentType<MapViewProps>> | null = null;

/** The map component, from its own chunk (MapLibre included). Loads once; a failed load can be retried. */
export function loadMapView(): Promise<ComponentType<MapViewProps>> {
  loading ??= import('./MapView.js').then(
    (module) => module.MapView,
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

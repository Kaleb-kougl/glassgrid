/*
 * What the map test page (`?map-demo`, apps/web/src/map-demo/MapDemo.tsx)
 * exposes to the map E2E and benchmark: render counters from
 * @glassgrid/ui/map and the last selection and viewport it was told.
 */

export interface MapStats {
  frames: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
  glyphs: number;
  segments: number;
  readonly samples: number[];
}

export interface MapDemoHooks {
  readonly stats: () => Readonly<MapStats>;
  readonly resetStats: () => void;
  selected: string | null;
  viewport: { west: number; south: number; east: number; north: number } | null;
  polls: number;
  aircraft: number;
}

declare global {
  interface Window {
    __ggMapDemo?: MapDemoHooks;
  }
}

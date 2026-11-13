/*
 * The live-flights map's contract (milestone L3; L4 added `selectedTrack`).
 * Types only: importing this module (or `@glassgrid/ui/map`) costs nothing
 * at first load; MapLibre arrives with `loadMapView()`'s lazy chunk.
 */

export interface MapAircraft {
  hex: string;
  flight: string | null;
  typeCode: string | null;
  category: string | null;
  lat: number;
  lon: number;
  altBaroFt: number | null;
  altGeomFt: number | null;
  onGround: boolean;
  gsKt: number | null;
  trackDeg: number | null;
  baroRateFpm: number | null;
  ts: number /* epoch ms of this fix */;
}

export interface MapTrailPoint {
  hex: string;
  ts: number;
  lat: number;
  lon: number;
  altBaroFt: number | null;
}

export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface MapViewProps {
  aircraft: readonly MapAircraft[]; // latest fix per aircraft, already filtered
  trails: readonly MapTrailPoint[]; // sorted by hex then ts; the last ~5 min
  dataClockMs: number; // feed data clock when these rows were queried
  playing: boolean; // dead reckoning advances only while true
  speed?: number; // replay speed multiplier (default 1)
  initialView?: { center: [lon: number, lat: number]; zoom: number };
  /**
   * The data's extent (L4): the map pans and zooms out far enough that all
   * of it shows (its max bounds grow to fit it, `mapMaxBounds`), so the
   * "Filter to map view" box can cover every fix. Absent: the basemap's box.
   */
  dataBounds?: MapBounds;
  attribution: readonly string[]; // e.g. 'Aircraft data © adsb.lol contributors, ODbL 1.0'
  onViewportChange?: (bounds: MapBounds) => void; // debounced, after pan/zoom ends
  onSelect?: (hex: string | null) => void;
  selectedHex?: string | null;
  /**
   * L4: the selected aircraft's whole track up to the data clock (its fixes
   * in the loaded data, ordered by ts; unsorted input is sorted). Drawn as a
   * solid, opaque line in the selection colour, wider than the fading
   * 5-minute trails and above them; only points whose `hex` is
   * `selectedHex` are drawn. Thinned like trails (one point per 8 s, more
   * in turns), at most 5,000 points used (the newest), and broken where two
   * fixes are more than 5 minutes apart. Optional: absent or empty draws no
   * track (L3 behaviour). Keep it referentially stable between queries.
   */
  selectedTrack?: readonly MapTrailPoint[];
  theme: 'light' | 'dark';
  assetsBase: string; // same-origin URL prefix of apps/web/public/map/
}

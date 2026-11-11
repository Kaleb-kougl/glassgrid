import { z } from 'zod';
import { FilterSchema } from './filter.js';

/*
 * A map view (milestone L3, docs/live-flights-l3-data.md): aircraft at their
 * latest fix, with short trails, over a table in the flight-point layout
 * (`flight_states`, or a flights Parquet file opened like any other).
 *
 * The spec names the four columns a map cannot do without (position, the
 * aircraft's id and the fix time); every other attribute the map shows
 * (callsign, type, category, altitudes, speed, track, vertical rate,
 * on-ground) is read by its `FlightPoint` name when the table has it and is
 * null otherwise. Validated with this schema at every boundary (UI,
 * commands, saved workspace, engine request), like `ChartSpecSchema`; rules
 * the schema cannot express (column types) are the compiler's
 * (`compileMapLatestQuery`).
 */

/** Trail length when a map view does not say. */
export const DEFAULT_MAP_TRAIL_MINUTES = 5;
/** Longest trail a map view may ask for. */
export const MAX_MAP_TRAIL_MINUTES = 30;
/**
 * An aircraft is on the map while its latest fix is at most this old at the
 * data clock, so aircraft that land, leave the box or stop reporting vanish.
 * 90 s, not L0's 60 s "aircraft in view": the fixtures have many gaps of 60
 * to 70 s between one aircraft's fixes, and at 60 s those aircraft blinked
 * out for a batch. The map still extrapolates a fix for at most 60 s
 * (`@glassgrid/ui/map`, dead-reckoning.ts), so an aircraft that stopped
 * reporting stands still for its last 30 s instead of flying on.
 */
export const MAP_FRESHNESS_MS = 90_000;
/** Most aircraft one latest-fix query returns (the freshest ones). The Bay Area peaks under 200. */
export const MAX_MAP_AIRCRAFT = 2_000;
/** A trail keeps at most one fix per 1/MAP_TRAIL_BUCKETS of its length (and the newest fix of each), so at most this many + 1 points. */
export const MAP_TRAIL_BUCKETS = 100;
/** Most trail points one query returns: every aircraft at its full trail. */
export const MAX_MAP_TRAIL_POINTS = MAX_MAP_AIRCRAFT * (MAP_TRAIL_BUCKETS + 1);

/**
 * The selected aircraft's track (milestone L4, docs/live-flights-l4.md): its
 * fixes in the MAP_TRACK_SPAN_MS up to the data clock, thinned to at most
 * one per 1/MAP_TRACK_BUCKETS of the track's span (the newest in each), and
 * never closer than MIN_MAP_TRACK_BUCKET_MS, so at most MAP_TRACK_BUCKETS + 1
 * points however long the aircraft was seen (two hours: one per 3.6 s).
 */
export const MAP_TRACK_BUCKETS = 2_000;
/**
 * How far back a track reaches: two hours before the data clock (longer
 * than any flight through the Bay Area box; the live table keeps one). A
 * bounded time range lets DuckDB skip the rest of a day's table (ordered by
 * time) instead of scanning all of it on every selection and step.
 */
export const MAP_TRACK_SPAN_MS = 2 * 3_600_000;
/** Finest track thinning: one fix per 2 s (the fixtures' median gap between one aircraft's fixes is 2.1 s). */
export const MIN_MAP_TRACK_BUCKET_MS = 2_000;
/** Most points one track query returns. */
export const MAX_MAP_TRACK_POINTS = MAP_TRACK_BUCKETS + 1;
/** Longest aircraft id a track query accepts (readsb hex ids are 6 characters; `~`-prefixed TIS-B ids 7). */
export const MAX_MAP_AIRCRAFT_ID = 64;

const ColumnRefSchema = z.string().min(1).max(1024);

export const MapSpecSchema = z.strictObject({
  kind: z.literal('map'),
  /** Latitude in degrees (numeric). */
  lat: ColumnRefSchema.default('lat'),
  /** Longitude in degrees (numeric). */
  lon: ColumnRefSchema.default('lon'),
  /** One aircraft (text or integer): the latest fix is taken per value. */
  id: ColumnRefSchema.default('hex'),
  /** The fix time (timestamp): what the data clock and the trail window compare. */
  time: ColumnRefSchema.default('ts'),
  /**
   * Only aircraft whose latest fix matches every filter (cross-filter
   * selections and user filters, like a chart's). They apply to the latest
   * fix, not to each fix before it: a map shows where aircraft are now.
   */
  filters: z.array(FilterSchema).default([]),
  /** Trail length behind the data clock, whole minutes; 0 for none. */
  trailMinutes: z.number().int().min(0).max(MAX_MAP_TRAIL_MINUTES).default(DEFAULT_MAP_TRAIL_MINUTES),
});
export type MapSpec = z.infer<typeof MapSpecSchema>;
export type MapSpecInput = z.input<typeof MapSpecSchema>;

/**
 * The latest-fix query's columns, in order: the map component's `MapAircraft`
 * fields, then `registration` (L4: the app's details panel shows it; the
 * component ignores it).
 */
export const MAP_AIRCRAFT_FIELDS = [
  'hex',
  'flight',
  'typeCode',
  'category',
  'lat',
  'lon',
  'altBaroFt',
  'altGeomFt',
  'onGround',
  'gsKt',
  'trackDeg',
  'baroRateFpm',
  'ts',
  'registration',
] as const;

/** The trails query's columns, in order: the component's `MapTrailPoint` fields. */
export const MAP_TRAIL_FIELDS = ['hex', 'ts', 'lat', 'lon', 'altBaroFt'] as const;

/** One aircraft at its latest fix, as the latest-fix query returns it (numbers are DOUBLE, `ts` epoch ms). */
export interface MapAircraftRow {
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
  /** Epoch milliseconds of this fix. */
  ts: number;
  /** The aircraft's registration (tail number) at this fix, when the table has it. */
  registration: string | null;
}

/** One trail fix, as the trails query returns it (ordered by hex, then ts); also one track fix (ordered by ts). */
export interface MapTrailRow {
  hex: string;
  ts: number;
  lat: number;
  lon: number;
  altBaroFt: number | null;
}

/** Every column a map spec reads by name from its spec (the optional attribute columns are not required). */
export function mapSpecColumns(spec: MapSpec): string[] {
  return [...new Set([spec.lat, spec.lon, spec.id, spec.time, ...spec.filters.map((filter) => filter.column)])];
}

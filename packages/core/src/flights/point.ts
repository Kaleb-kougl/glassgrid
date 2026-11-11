import { z } from 'zod';

/**
 * One position fix of one aircraft, in aviation units, as Glassgrid's flight
 * views store and replay it. Both sources map onto this shape:
 *
 * - `live`: an aircraft object from a readsb-style API response (adsb.lol's
 *   ADSBExchange-v2-compatible endpoints, or readsb's own aircraft.json),
 *   mapped by `fromReadsbAircraft`;
 * - `archive`: a point of a readsb trace file (adsb.lol's daily
 *   `globe_history` releases), mapped by `fromTracePoint` / `fromTrace`.
 *
 * Field meanings follow readsb's README-json.md (aircraft.json keys and the
 * "trace jsons" layout). Fields a source does not report are `null`, never
 * guessed. Only `ts`, `hex`, `lat`, `lon`, `onGround` and `source` are always
 * present.
 */

/** Where a point came from. */
export const FLIGHT_SOURCES = ['live', 'archive'] as const;
export const FlightSourceSchema = z.enum(FLIGHT_SOURCES);
export type FlightSource = z.infer<typeof FlightSourceSchema>;

/**
 * readsb's 24-bit address as six lowercase hex digits. A leading `~` marks a
 * non-ICAO address (TIS-B / ADS-R track ids, anonymised addresses); readsb
 * uses the same spelling in aircraft.json and in trace file names.
 */
export const FLIGHT_HEX_PATTERN = /^~?[0-9a-f]{6}$/;

/** Emitter category, `A0`..`D7` (DO-260B 2.2.3.2.5.2). */
export const FLIGHT_CATEGORY_PATTERN = /^[A-D][0-7]$/;

/** Mode A code: four octal digits. */
export const FLIGHT_SQUAWK_PATTERN = /^[0-7]{4}$/;

/** Zod 4 numbers are finite: NaN and ±Infinity are rejected. */
const finite = z.number();

export const FlightPointSchema = z.object({
  /** Time of the position fix: integer epoch milliseconds, UTC. */
  ts: z.number().int().nonnegative(),
  hex: z.string().regex(FLIGHT_HEX_PATTERN),
  /** Callsign / flight number, trimmed (readsb pads it to 8 characters); null when not reported. */
  flight: z.string().min(1).max(8).nullable(),
  /** Registration from adsb.lol's aircraft database (readsb `r`). */
  registration: z.string().min(1).nullable(),
  /** ICAO aircraft type designator from the database (readsb `t`), e.g. `B738`. */
  typeCode: z.string().min(1).nullable(),
  /** WGS84 degrees. */
  lat: finite.min(-90).max(90),
  lon: finite.min(-180).max(180),
  /** Barometric (pressure) altitude in feet; null on the ground, when unknown, or when the source only had a geometric altitude. */
  altBaroFt: finite.nullable(),
  /** Geometric (GNSS) altitude in feet above the WGS84 ellipsoid. */
  altGeomFt: finite.nullable(),
  /** True when the aircraft reported itself on the ground (readsb altitude `"ground"`). */
  onGround: z.boolean(),
  /** Ground speed, knots. */
  gsKt: finite.min(0).nullable(),
  /** True track over ground, degrees [0, 360). On the ground readsb's traces give true heading here instead. */
  trackDeg: finite.min(0).lt(360).nullable(),
  /** Rate of change of barometric altitude, feet per minute. */
  baroRateFpm: finite.nullable(),
  /** Rate of change of geometric altitude, feet per minute. */
  geomRateFpm: finite.nullable(),
  category: z.string().regex(FLIGHT_CATEGORY_PATTERN).nullable(),
  squawk: z.string().regex(FLIGHT_SQUAWK_PATTERN).nullable(),
  /** readsb's position source (`adsb_icao`, `mlat`, `tisb_other`, ...), when given. */
  posType: z.string().min(1).max(32).nullable(),
  source: FlightSourceSchema,
});
export type FlightPoint = z.infer<typeof FlightPointSchema>;

/** Column order of a flight point: the order the Parquet fixtures use. */
export const FLIGHT_POINT_FIELDS = [
  'ts',
  'hex',
  'flight',
  'registration',
  'typeCode',
  'lat',
  'lon',
  'altBaroFt',
  'altGeomFt',
  'onGround',
  'gsKt',
  'trackDeg',
  'baroRateFpm',
  'geomRateFpm',
  'category',
  'squawk',
  'posType',
  'source',
] as const satisfies readonly (keyof FlightPoint)[];

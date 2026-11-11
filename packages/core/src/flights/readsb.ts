import { type FlightBbox, inBbox } from './bbox.js';
import {
  FLIGHT_CATEGORY_PATTERN,
  FLIGHT_HEX_PATTERN,
  FLIGHT_SQUAWK_PATTERN,
  FlightPointSchema,
  type FlightPoint,
  type FlightSource,
} from './point.js';

/**
 * Pure adapters from readsb's JSON formats to `FlightPoint`. The formats are
 * documented in readsb's README-json.md (github.com/wiedehopf/readsb, `dev`
 * branch): "aircraft.json" for live aircraft objects, "trace jsons" for the
 * per-aircraft trace files in adsb.lol's `globe_history` archives.
 *
 * Every adapter takes `unknown` (parsed JSON from the network or an archive),
 * never throws, and returns `null` for anything that is not a usable
 * position: a missing or malformed hex, time or position. Optional fields
 * that are malformed become `null` on their own instead of dropping the
 * point. The result always satisfies `FlightPointSchema`.
 */

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegative(value: unknown): number | null {
  const n = num(value);
  return n !== null && n >= 0 ? n : null;
}

/** Degrees in [0, 360); readsb sends 0..359.99, a stray 360 wraps to 0. */
function degrees(value: unknown): number | null {
  const n = num(value);
  if (n === null || n < 0 || n > 360) return null;
  return n === 360 ? 0 : n;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

function matching(value: unknown, pattern: RegExp): string | null {
  const t = text(value, 16);
  return t !== null && pattern.test(t) ? t : null;
}

/** readsb hex ids, normalised to lowercase; null unless six hex digits (optionally `~`-prefixed). */
export function normalizeHex(value: unknown): string | null {
  const t = text(value, 7)?.toLowerCase() ?? null;
  return t !== null && FLIGHT_HEX_PATTERN.test(t) ? t : null;
}

function finish(point: FlightPoint): FlightPoint | null {
  const parsed = FlightPointSchema.safeParse(point);
  return parsed.success ? parsed.data : null;
}

function position(lat: unknown, lon: unknown): { lat: number; lon: number } | null {
  const la = num(lat);
  const lo = num(lon);
  if (la === null || lo === null || la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  return { lat: la, lon: lo };
}

// ---------------------------------------------------------------------------
// Live: aircraft.json / API aircraft objects

/**
 * Maps one readsb aircraft object (an element of aircraft.json's `aircraft`
 * or of an ADSBExchange-v2-style response's `ac`) to the fix it describes.
 *
 * `nowSec` is the response's `now` in epoch **seconds** (see
 * `readsbNowSeconds`). The fix time is `now - seen_pos` (falling back to
 * `seen`, then to `now`), rounded to whole milliseconds. Only the current
 * position (`lat`, `lon`) is used: `lastPosition` (older than 60 s) and
 * `rr_lat`/`rr_lon` (rough receiver-based estimates) are ignored, so an
 * aircraft without a current position gives `null`.
 *
 * On the ground (`alt_baro: "ground"`), `trackDeg` falls back to
 * `true_heading` when `track` is missing, as readsb's traces do.
 */
export function fromReadsbAircraft(ac: unknown, nowSec: number, source: FlightSource = 'live'): FlightPoint | null {
  if (!isObject(ac) || num(nowSec) === null) return null;
  const hex = normalizeHex(ac['hex']);
  const pos = position(ac['lat'], ac['lon']);
  if (hex === null || pos === null) return null;
  const age = nonNegative(ac['seen_pos']) ?? nonNegative(ac['seen']) ?? 0;
  const ts = Math.round((nowSec - age) * 1000);
  if (!Number.isSafeInteger(ts) || ts < 0) return null;

  const altBaro = ac['alt_baro'];
  const onGround = altBaro === 'ground';
  return finish({
    ts,
    hex,
    flight: text(ac['flight'], 8),
    registration: text(ac['r'], 16),
    typeCode: text(ac['t'], 8),
    lat: pos.lat,
    lon: pos.lon,
    altBaroFt: onGround ? null : num(altBaro),
    altGeomFt: num(ac['alt_geom']),
    onGround,
    gsKt: nonNegative(ac['gs']),
    trackDeg: degrees(ac['track']) ?? (onGround ? degrees(ac['true_heading']) : null),
    baroRateFpm: num(ac['baro_rate']),
    geomRateFpm: num(ac['geom_rate']),
    category: matching(ac['category'], FLIGHT_CATEGORY_PATTERN),
    squawk: matching(ac['squawk'], FLIGHT_SQUAWK_PATTERN),
    posType: text(ac['type'], 32),
    source,
  });
}

/**
 * A response's `now` in epoch seconds. readsb's aircraft.json gives seconds;
 * the ADSBExchange-v2-compatible output (readsb `&jv2`, which adsb.lol's
 * `/v2/...` endpoints are documented as) gives milliseconds. Values above
 * 1e11 (year 5138 in seconds, 1973 in milliseconds) are read as
 * milliseconds. Returns null when `now` is not a positive number.
 */
export function readsbNowSeconds(now: unknown): number | null {
  const n = num(now);
  if (n === null || n <= 0) return null;
  return n > 1e11 ? n / 1000 : n;
}

/**
 * The aircraft list and `now` of an aircraft.json document or a v2-style API
 * response (`ac`, or readsb's `aircraft`). Null when either is missing.
 */
export function parseReadsbResponse(json: unknown): { nowSec: number; aircraft: readonly unknown[] } | null {
  if (!isObject(json)) return null;
  const nowSec = readsbNowSeconds(json['now']);
  const list = Array.isArray(json['ac']) ? json['ac'] : Array.isArray(json['aircraft']) ? json['aircraft'] : null;
  if (nowSec === null || list === null) return null;
  return { nowSec, aircraft: list as readonly unknown[] };
}

// ---------------------------------------------------------------------------
// Archive: trace files

/** The per-aircraft fields of a trace file (everything except `trace`). */
export interface TraceHeader {
  /** `icao`: the hex id. */
  readonly icao: unknown;
  /** Epoch seconds; each point's first element is seconds after this. */
  readonly timestamp: unknown;
  /** Registration and type from the aircraft database, when known. */
  readonly r?: unknown;
  readonly t?: unknown;
}

/**
 * Per-aircraft details that trace points carry only now and then: readsb
 * attaches an aircraft object (element 8) to some points and `null` to the
 * rest. `fromTrace` carries the last one forward.
 */
export interface TraceCarry {
  flight: string | null;
  squawk: string | null;
  category: string | null;
}

export const EMPTY_TRACE_CARRY: Readonly<TraceCarry> = Object.freeze({ flight: null, squawk: null, category: null });

/** Trace point flag bits (README-json.md, "trace jsons"). */
export const TRACE_FLAGS = {
  /** No position received for 20 seconds before this one. */
  stale: 1,
  /** Start of a new leg (readsb's guess at a landing/takeoff boundary). */
  newLeg: 2,
  /** The vertical rate (element 7) is geometric, not barometric. */
  geomRate: 4,
  /** The altitude (element 3) is geometric, not barometric. */
  geomAltitude: 8,
} as const;

/** A point's flags (element 6); 0 unless a non-negative integer. */
function traceFlags(point: readonly unknown[]): number {
  const n = num(point[6]);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Maps one trace point to a fix. The layout (README-json.md):
 *
 * `[secondsAfterTimestamp, lat, lon, altitude ft | "ground" | null,
 *   groundSpeed kt | null, track deg | null, flags, verticalRate fpm | null,
 *   aircraft object | null, positionType | null, geometricAltitude | null,
 *   geometricRate | null, indicatedAirspeed | null, roll | null]`
 *
 * (the last five only in files from 2022 on). When flag 8 is set the
 * altitude is geometric, so it becomes `altGeomFt` (unless element 10 has
 * one) and `altBaroFt` is null; flag 4 does the same for the vertical rate.
 * Callsign, squawk and category come from this point's aircraft object
 * where it has them, else from `carry` (what an earlier point of the same
 * trace reported).
 */
export function fromTracePoint(header: unknown, value: unknown, carry: Readonly<TraceCarry> = EMPTY_TRACE_CARRY): FlightPoint | null {
  if (!isObject(header) || !Array.isArray(value)) return null;
  const point = value as readonly unknown[];
  const hex = normalizeHex(header['icao']);
  const base = num(header['timestamp']);
  const offset = num(point[0]);
  const pos = position(point[1], point[2]);
  if (hex === null || base === null || offset === null || pos === null) return null;
  const ts = Math.round((base + offset) * 1000);
  if (!Number.isSafeInteger(ts) || ts < 0) return null;

  const flags = traceFlags(point);
  const details = isObject(point[8]) ? point[8] : null;
  const altitude = point[3];
  const onGround = altitude === 'ground';
  const altGeomAltitude = (flags & TRACE_FLAGS.geomAltitude) !== 0;
  const rateIsGeom = (flags & TRACE_FLAGS.geomRate) !== 0;
  const rate = num(point[7]);

  return finish({
    ts,
    hex,
    flight: (details ? text(details['flight'], 8) : null) ?? carry.flight,
    registration: text(header['r'], 16),
    typeCode: text(header['t'], 8),
    lat: pos.lat,
    lon: pos.lon,
    altBaroFt: onGround || altGeomAltitude ? null : num(altitude),
    altGeomFt: num(point[10]) ?? (altGeomAltitude && !onGround ? num(altitude) : null) ?? (details ? num(details['alt_geom']) : null),
    onGround,
    gsKt: nonNegative(point[4]),
    trackDeg: degrees(point[5]),
    baroRateFpm: rateIsGeom ? null : rate,
    geomRateFpm: num(point[11]) ?? (rateIsGeom ? rate : null),
    category: (details ? matching(details['category'], FLIGHT_CATEGORY_PATTERN) : null) ?? carry.category,
    squawk: (details ? matching(details['squawk'], FLIGHT_SQUAWK_PATTERN) : null) ?? carry.squawk,
    posType: text(point[9], 32) ?? (details ? text(details['type'], 32) : null),
    source: 'archive',
  });
}

export interface FromTraceOptions {
  /** Keep only fixes inside this box (details are still carried through points outside it). */
  readonly bbox?: FlightBbox;
}

/**
 * Every usable fix of a whole trace file (`{ icao, timestamp, r?, t?, trace:
 * [...] }`), in file order. Callsign, squawk and category are carried
 * forward from the last point that had an aircraft object, and reset at the
 * start of each new leg (flag 2) so one flight's callsign never leaks into
 * the next. Returns `[]` for anything that is not a trace file.
 */
export function fromTrace(file: unknown, options: FromTraceOptions = {}): FlightPoint[] {
  if (!isObject(file) || !Array.isArray(file['trace'])) return [];
  const out: FlightPoint[] = [];
  let carry: TraceCarry = { ...EMPTY_TRACE_CARRY };
  for (const value of file['trace'] as unknown[]) {
    if (!Array.isArray(value)) continue;
    const point = value as readonly unknown[];
    if ((traceFlags(point) & TRACE_FLAGS.newLeg) !== 0) carry = { ...EMPTY_TRACE_CARRY };
    const details = point[8];
    if (isObject(details)) {
      carry = {
        flight: text(details['flight'], 8) ?? carry.flight,
        squawk: matching(details['squawk'], FLIGHT_SQUAWK_PATTERN) ?? carry.squawk,
        category: matching(details['category'], FLIGHT_CATEGORY_PATTERN) ?? carry.category,
      };
    }
    if (options.bbox) {
      const lat = num(point[1]);
      const lon = num(point[2]);
      if (lat === null || lon === null || !inBbox(lat, lon, options.bbox)) continue;
    }
    const fix = fromTracePoint(file, point, carry);
    if (fix) out.push(fix);
  }
  return out;
}

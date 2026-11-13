import { LIVE_FIX_TOLERANCE_MS, type FlightPoint } from '@glassgrid/core';

/*
 * Which fixes of a batch are new to `flight_states` (docs/live-flights-l2.md,
 * "Dedup").
 *
 * 1. **Exact key (every source).** One row per (hex, ts). A replay that
 *    delivers a window twice, or a live poll answered from the CDN's cache
 *    (the same body again), adds nothing.
 * 2. **Re-reported live fixes.** A live fix's time is `now - seen_pos`. The
 *    next poll reports the same position fix again (readsb keeps it until a
 *    newer position arrives) with a later `now` and a larger `seen_pos`, and
 *    the two are each rounded (to 0.1 s and 1 ms), so the same fix can come
 *    back a few milliseconds off. Two `live` fixes of the same aircraft at
 *    the identical stored position (lat and lon after rounding to 5
 *    decimals) whose times are at most `toleranceMs` apart are the same fix;
 *    the first one ingested is kept. Altitude, speed and track are left out
 *    of the identity on purpose: readsb updates them from other messages
 *    between position updates, so a re-reported position can carry a newer
 *    altitude.
 *
 *    Quantising `ts` instead (e.g. to whole seconds) would not work: a fix
 *    at 12.999 s and its re-report at 13.001 s land in different buckets.
 *    The rule can merge a genuinely new fix only when it repeats the stored
 *    position exactly within the tolerance (a parked aircraft), and then the
 *    dropped row carries no information the kept one lacks. Archive
 *    (replay) rows never merge this way: their times are exact, and the
 *    fixtures hold distinct fixes at the same spot (68,078 distinct
 *    positions among 71,595 rows in the 30-minute file).
 *
 * The rule is applied greedily in arrival order against the rows already
 * kept (stored rows, then earlier rows of the batch), never against rows it
 * dropped. So every dropped fix has a kept twin that stays (until retention),
 * which makes ingest idempotent: ingesting rows that were already ingested,
 * as a repeated or overlapping batch, changes nothing, and
 * `ingest(A); ingest(B)` equals `ingest(A ++ (B minus A))`.
 */

/** The fields the rule looks at, at stored precision. */
export type FixIdentity = Pick<FlightPoint, 'hex' | 'ts' | 'lat' | 'lon' | 'source'>;

/** The exact key (hex, ts). */
export function fixKey(fix: Pick<FlightPoint, 'hex' | 'ts'>): string {
  return `${fix.hex}|${fix.ts}`;
}

/**
 * The fixes of `batch` to insert, in batch order: not an exact (hex, ts)
 * repeat of a stored or earlier kept fix, and, for `live` fixes, not a
 * re-report (same hex, identical lat and lon, |Δts| <= `toleranceMs`) of a
 * stored or earlier kept live fix. `stored` must hold every stored fix that
 * could match, i.e. at least those with ts in [min(batch ts) - tolerance,
 * max(batch ts) + tolerance]. Values must already be at stored precision
 * (`toStoredPoint`).
 */
export function newFixes<T extends FixIdentity>(stored: Iterable<FixIdentity>, batch: readonly T[], toleranceMs: number = LIVE_FIX_TOLERANCE_MS): T[] {
  const exact = new Set<string>();
  const live = new Map<string, FixIdentity[]>();
  const remember = (fix: FixIdentity) => {
    exact.add(fixKey(fix));
    if (fix.source !== 'live') return;
    const list = live.get(fix.hex);
    if (list) list.push(fix);
    else live.set(fix.hex, [fix]);
  };
  for (const fix of stored) remember(fix);
  const kept: T[] = [];
  for (const fix of batch) {
    if (exact.has(fixKey(fix))) continue;
    if (fix.source === 'live') {
      const twins = live.get(fix.hex);
      if (twins?.some((other) => other.lat === fix.lat && other.lon === fix.lon && Math.abs(other.ts - fix.ts) <= toleranceMs)) continue;
    }
    remember(fix);
    kept.push(fix);
  }
  return kept;
}

/** Half away from zero, like DuckDB's `round` and its DOUBLE-to-DECIMAL cast. */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(Math.abs(value) * factor) / factor;
  // No -0: DuckDB stores and returns 0.
  return value < 0 && rounded !== 0 ? -rounded : rounded;
}

/**
 * DuckDB's INTEGER range. Altitudes and vertical rates are INTEGER columns,
 * so a value outside it (one garbled aircraft at 3e9 ft) would fail the
 * batch's CAST and roll back every fix in it, poll after poll. Such values
 * become null. Narrower "physical" bounds are not applied: the archive
 * itself holds implausible rates (-142,136 ft/min in the 30-minute fixture),
 * and live and replayed fixes are stored alike.
 */
export const STORED_INTEGER_MIN = -2_147_483_648;
export const STORED_INTEGER_MAX = 2_147_483_647;

function integerOrNull(value: number | null): number | null {
  const rounded = roundOrNull(value, 0);
  return rounded === null || rounded < STORED_INTEGER_MIN || rounded > STORED_INTEGER_MAX ? null : rounded;
}

function roundOrNull(value: number | null, decimals: number): number | null {
  return value === null ? null : roundTo(value, decimals);
}

/** Positions to 5 decimals (about 1 m), as the fixtures store them. */
export const STORED_LAT_LON_DECIMALS = 5;
/** Speed and track to 0.1 kt and 0.1°, as the fixtures store them. */
export const STORED_SPEED_TRACK_DECIMALS = 1;

/**
 * C0 controls and DEL (every UTF-16 unit outside U+0020-U+007E and
 * U+0080-U+FFFF): never part of a callsign or registration, and U+001F
 * separates bound values (flight-store.ts).
 */
const CONTROL_CHARACTERS = /[^\u0020-\u007e\u0080-\uffff]/g;

function cleanText(value: string | null): string | null {
  return value === null ? null : value.replace(CONTROL_CHARACTERS, '\ufffd');
}

/**
 * A fix as `flight_states` stores it, at the fixtures' precision
 * (tools/datasets/src/lib/flights.ts): lat/lon to 5 decimals, altitudes and
 * vertical rates to whole feet (per minute) and null outside DuckDB's
 * INTEGER range, speed and track to 0.1, with a track that rounds to 360
 * wrapped to 0; control characters in text
 * replaced by U+FFFD. Values already at that precision (every fixture row)
 * come back unchanged, so a replay stores the fixture's values exactly.
 * This happens once, before dedup, so dedup compares exactly what the table
 * will hold.
 */
export function toStoredPoint(point: FlightPoint): FlightPoint {
  const track = roundOrNull(point.trackDeg, STORED_SPEED_TRACK_DECIMALS);
  return {
    ...point,
    flight: cleanText(point.flight),
    registration: cleanText(point.registration),
    typeCode: cleanText(point.typeCode),
    posType: cleanText(point.posType),
    lat: roundTo(point.lat, STORED_LAT_LON_DECIMALS),
    lon: roundTo(point.lon, STORED_LAT_LON_DECIMALS),
    altBaroFt: integerOrNull(point.altBaroFt),
    altGeomFt: integerOrNull(point.altGeomFt),
    gsKt: roundOrNull(point.gsKt, STORED_SPEED_TRACK_DECIMALS),
    trackDeg: track === null ? null : track % 360,
    baroRateFpm: integerOrNull(point.baroRateFpm),
    geomRateFpm: integerOrNull(point.geomRateFpm),
  };
}

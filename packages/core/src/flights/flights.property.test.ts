import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BAY_AREA_BBOX, inBbox } from './bbox.js';
import { FlightPointSchema } from './point.js';
import { fromReadsbAircraft, fromTrace, fromTracePoint } from './readsb.js';

/*
 * Properties of the readsb adapters: they never throw on arbitrary JSON,
 * whatever they return is a valid FlightPoint, "ground" always means on the
 * ground without a barometric altitude, and a bbox filter never lets an
 * outside fix through.
 */

const SEED = 20261110;
const RUNS = { seed: SEED, numRuns: 500 };

const hexArb = fc.stringMatching(/^[0-9a-fA-F]{6}$/);
const altitudeArb = fc.oneof(fc.constant('ground'), fc.integer({ min: -1500, max: 60000 }), fc.constant(null), fc.string());
const maybeNumber = fc.oneof(fc.double(), fc.constant(null), fc.string(), fc.boolean());

/** Trace points shaped like readsb's (element types right most of the time, wrong some of the time). */
const tracePointArb = fc.tuple(
  fc.oneof(fc.double({ min: 0, max: 90000, noNaN: true }), maybeNumber),
  fc.oneof(fc.double({ min: 36, max: 39.5, noNaN: true }), maybeNumber),
  fc.oneof(fc.double({ min: -124, max: -120.5, noNaN: true }), maybeNumber),
  altitudeArb,
  maybeNumber,
  maybeNumber,
  fc.oneof(fc.integer({ min: 0, max: 15 }), maybeNumber),
  maybeNumber,
  fc.oneof(fc.constant(null), fc.record({ flight: fc.string({ maxLength: 10 }), squawk: fc.string({ maxLength: 4 }), category: fc.string({ maxLength: 2 }) }, { requiredKeys: [] }), fc.jsonValue()),
  fc.oneof(fc.constant('adsb_icao'), fc.constant('mlat'), fc.constant(null), fc.jsonValue()),
);

const headerArb = fc.record({
  icao: fc.oneof(hexArb, fc.string()),
  timestamp: fc.oneof(fc.double({ min: 1.6e9, max: 1.9e9, noNaN: true }), maybeNumber),
  r: fc.oneof(fc.string(), fc.constant(undefined)),
  t: fc.oneof(fc.string(), fc.constant(undefined)),
});

const aircraftArb = fc.record(
  {
    hex: fc.oneof(hexArb, fc.string(), fc.jsonValue()),
    lat: fc.oneof(fc.double({ min: 36, max: 39.5, noNaN: true }), maybeNumber),
    lon: fc.oneof(fc.double({ min: -124, max: -120.5, noNaN: true }), maybeNumber),
    alt_baro: altitudeArb,
    alt_geom: maybeNumber,
    gs: maybeNumber,
    track: maybeNumber,
    true_heading: maybeNumber,
    baro_rate: maybeNumber,
    seen_pos: maybeNumber,
    flight: fc.oneof(fc.string({ maxLength: 10 }), fc.jsonValue()),
    squawk: fc.oneof(fc.stringMatching(/^[0-7]{4}$/), fc.string()),
    category: fc.oneof(fc.constant('A3'), fc.string()),
    type: fc.oneof(fc.constant('adsb_icao'), fc.jsonValue()),
  },
  { requiredKeys: [] },
);

function valid(point: unknown): boolean {
  return FlightPointSchema.safeParse(point).success;
}

describe('readsb adapters (properties)', () => {
  it('never throw on arbitrary JSON, and return null for it unless it is a usable fix', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), fc.double(), (a, b, now) => {
        const live = fromReadsbAircraft(a, now);
        const archive = fromTracePoint(a, b);
        const all = fromTrace(a, { bbox: BAY_AREA_BBOX });
        expect(live === null || valid(live)).toBe(true);
        expect(archive === null || valid(archive)).toBe(true);
        expect(all.every(valid)).toBe(true);
      }),
      { ...RUNS, numRuns: 2000 },
    );
  });

  it('trace points: the result is valid, and "ground" means onGround with no barometric altitude', () => {
    fc.assert(
      fc.property(headerArb, tracePointArb, (header, point) => {
        const fix = fromTracePoint(header, point);
        if (fix === null) return;
        expect(valid(fix)).toBe(true);
        expect(fix.onGround).toBe(point[3] === 'ground');
        if (point[3] === 'ground') expect(fix.altBaroFt).toBeNull();
        expect(fix.source).toBe('archive');
      }),
      RUNS,
    );
  });

  it('live aircraft: the result is valid, "ground" means onGround with no barometric altitude, and the fix is never after now', () => {
    fc.assert(
      fc.property(aircraftArb, fc.double({ min: 1.6e9, max: 1.9e9, noNaN: true }), (ac, now) => {
        const fix = fromReadsbAircraft(ac, now);
        if (fix === null) return;
        expect(valid(fix)).toBe(true);
        expect(fix.onGround).toBe(ac.alt_baro === 'ground');
        if (ac.alt_baro === 'ground') expect(fix.altBaroFt).toBeNull();
        expect(fix.ts).toBeLessThanOrEqual(Math.round(now * 1000));
        expect(fix.source).toBe('live');
      }),
      RUNS,
    );
  });

  it('a bbox filter keeps exactly the usable fixes inside the box, in order', () => {
    fc.assert(
      fc.property(headerArb, fc.array(tracePointArb, { maxLength: 30 }), (header, trace) => {
        const file = { ...header, trace };
        const inside = fromTrace(file, { bbox: BAY_AREA_BBOX });
        const all = fromTrace(file);
        expect(inside.every((fix) => inBbox(fix.lat, fix.lon, BAY_AREA_BBOX))).toBe(true);
        expect(inside).toEqual(all.filter((fix) => inBbox(fix.lat, fix.lon, BAY_AREA_BBOX)));
      }),
      RUNS,
    );
  });
});

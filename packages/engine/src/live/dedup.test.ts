import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LIVE_FIX_TOLERANCE_MS, type FlightPoint } from '@glassgrid/core';
import { fixKey, newFixes, toStoredPoint, type FixIdentity } from './dedup';

/*
 * The dedup rule on its own (pure, many runs); flight-store.test.ts checks
 * the same properties on the real table under both drivers.
 */

const RUNS = { seed: 20261111, numRuns: 400 };
const TOL = LIVE_FIX_TOLERANCE_MS;
const BASE = 1_794_268_000_000;

const fixArb: fc.Arbitrary<FixIdentity> = fc.record({
  hex: fc.constantFrom('a00001', 'a00002', '~b00003'),
  // A narrow time range and a 3x3 position grid, so exact repeats, near repeats and parked aircraft are common.
  ts: fc.integer({ min: BASE, max: BASE + 12_000 }),
  lat: fc.constantFrom(37.6, 37.60001, 37.7),
  lon: fc.constantFrom(-122.4, -122.40001, -122.3),
  source: fc.constantFrom('live' as const, 'archive' as const),
});
const batchArb = fc.array(fixArb, { maxLength: 40 });

function ingestAll(batches: readonly (readonly FixIdentity[])[]): FixIdentity[] {
  const table: FixIdentity[] = [];
  for (const batch of batches) table.push(...newFixes(table, batch));
  return table;
}

describe('newFixes', () => {
  it('ingesting the same batch again adds nothing', () => {
    fc.assert(
      fc.property(batchArb, batchArb, (before, batch) => {
        const table = ingestAll([before, batch]);
        expect(newFixes(table, batch)).toEqual([]);
      }),
      RUNS,
    );
  });

  it('ingesting any rows that were already ingested adds nothing', () => {
    fc.assert(
      fc.property(fc.array(batchArb, { maxLength: 4 }), fc.infiniteStream(fc.boolean()), (batches, pick) => {
        const table = ingestAll(batches);
        const again = batches.flat().filter(() => pick.next().value);
        expect(newFixes(table, again)).toEqual([]);
      }),
      RUNS,
    );
  });

  it('overlapping batches give the table of their union in arrival order', () => {
    fc.assert(
      fc.property(batchArb, fc.nat(), fc.nat(), batchArb, (a, from, length, extra) => {
        // B repeats a slice of A and adds new fixes: a re-poll that overlaps the last one.
        const start = a.length === 0 ? 0 : from % a.length;
        const b = [...a.slice(start, start + (length % 20)), ...extra];
        const twoBatches = ingestAll([a, b]);
        const union = [...a, ...b.filter((fix) => !a.includes(fix))];
        expect(twoBatches).toEqual(ingestAll([union]));
      }),
      RUNS,
    );
  });

  it('keeps one row per (hex, ts) and never two live fixes that are re-reports of each other', () => {
    fc.assert(
      fc.property(fc.array(batchArb, { maxLength: 4 }), (batches) => {
        const table = ingestAll(batches);
        expect(new Set(table.map(fixKey)).size).toBe(table.length);
        const live = table.filter((fix) => fix.source === 'live');
        for (const [i, x] of live.entries()) {
          for (const y of live.slice(i + 1)) {
            const twins = x.hex === y.hex && x.lat === y.lat && x.lon === y.lon && Math.abs(x.ts - y.ts) <= TOL;
            expect(twins, `${JSON.stringify(x)} ~ ${JSON.stringify(y)}`).toBe(false);
          }
        }
      }),
      RUNS,
    );
  });

  it('re-reports of a live fix with time jitter within the tolerance collapse to one row, however they are batched', () => {
    // Distinct true fixes: per aircraft at least 3x the tolerance apart, so re-reports of different fixes never meet.
    const truthArb = fc.uniqueArray(
      fc.record({ hex: fc.constantFrom('a00001', 'a00002'), slot: fc.integer({ min: 0, max: 30 }), lat: fc.constantFrom(37.6, 37.7), lon: fc.constantFrom(-122.4, -122.3) }),
      { selector: (fix) => `${fix.hex}|${fix.slot}`, maxLength: 20 },
    );
    fc.assert(
      fc.property(
        truthArb,
        fc.array(fc.integer({ min: -TOL / 2, max: TOL / 2 }), { minLength: 1, maxLength: 4 }),
        fc.array(fc.nat(), { minLength: 200, maxLength: 200 }),
        (truth, jitters, randomness) => {
          let cursor = 0;
          const draw = () => randomness[cursor++ % randomness.length] ?? 0;
          const reports = truth.flatMap((fix) =>
            jitters.map((jitter): FixIdentity => ({ hex: fix.hex, lat: fix.lat, lon: fix.lon, ts: BASE + fix.slot * 3 * TOL + jitter, source: 'live' })),
          );
          // Shuffle, then split into polls at random points.
          const shuffled = reports.map((fix) => ({ fix, key: draw() })).sort((x, y) => x.key - y.key).map((entry) => entry.fix);
          const polls: FixIdentity[][] = [[]];
          for (const fix of shuffled) {
            if (draw() % 3 === 0) polls.push([]);
            polls[polls.length - 1]?.push(fix);
          }
          expect(ingestAll(polls)).toHaveLength(truth.length);
        },
      ),
      RUNS,
    );
  });

  it('never merges archive fixes, only exact repeats', () => {
    const at = (ts: number): FixIdentity => ({ hex: 'a00001', ts, lat: 37.6, lon: -122.4, source: 'archive' });
    expect(newFixes([], [at(BASE), at(BASE + 500), at(BASE), at(BASE + 1)])).toEqual([at(BASE), at(BASE + 500), at(BASE + 1)]);
    const live = (ts: number, lat = 37.6): FixIdentity => ({ ...at(ts), lat, source: 'live' });
    expect(newFixes([], [live(BASE), live(BASE + 400), live(BASE + TOL + 1), live(BASE + 400, 37.60001)])).toEqual([live(BASE), live(BASE + TOL + 1), live(BASE + 400, 37.60001)]);
  });
});

describe('toStoredPoint', () => {
  const point: FlightPoint = {
    ts: BASE,
    hex: 'a1b2c3',
    flight: 'UAL1',
    registration: null,
    typeCode: null,
    lat: 37.6123449,
    lon: -122.000005,
    altBaroFt: 12_337.5,
    altGeomFt: -0.4,
    onGround: false,
    gsKt: 451.25,
    trackDeg: 359.96,
    baroRateFpm: -64.5,
    geomRateFpm: null,
    category: 'A3',
    squawk: '1200',
    posType: 'adsb_icao',
    source: 'live',
  };

  it('rounds as the fixtures store values (half away from zero, track wrapped, no -0)', () => {
    expect(toStoredPoint(point)).toMatchObject({ lat: 37.61234, lon: -122.00001, altBaroFt: 12_338, altGeomFt: 0, gsKt: 451.3, trackDeg: 0, baroRateFpm: -65 });
    expect(Object.is(toStoredPoint(point).altGeomFt, 0)).toBe(true);
  });

  it('nulls altitudes and rates outside DuckDB\'s INTEGER range instead of failing the batch', () => {
    const wild = toStoredPoint({ ...point, altBaroFt: 3e9, altGeomFt: -3e9, baroRateFpm: 2_147_483_647.4, geomRateFpm: 2_147_483_647.6 });
    expect(wild).toMatchObject({ altBaroFt: null, altGeomFt: null, baroRateFpm: 2_147_483_647, geomRateFpm: null });
    // The archive's own implausible values stay (the replay gate is exact).
    expect(toStoredPoint({ ...point, baroRateFpm: -142_136 }).baroRateFpm).toBe(-142_136);
  });

  it('leaves values at stored precision unchanged', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -9_000_000, max: 9_000_000 }),
        fc.integer({ min: -18_000_000, max: 18_000_000 }),
        fc.integer({ min: 0, max: 9_999 }),
        fc.integer({ min: 0, max: 3_599 }),
        (lat, lon, gs, track) => {
          const stored = { ...point, lat: lat / 1e5, lon: lon / 1e5, altBaroFt: 1_000, altGeomFt: 1_025, gsKt: gs / 10, trackDeg: track / 10, baroRateFpm: -64 };
          expect(toStoredPoint(stored)).toEqual(stored);
        },
      ),
      RUNS,
    );
  });
});

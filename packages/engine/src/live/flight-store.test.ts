import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FlightPoint } from '@glassgrid/core';
import { testDriver } from '../test-support';
import { newFixes, toStoredPoint } from './dedup';
import { FlightStore, ROWS_PER_INSERT } from './flight-store';

/*
 * `flight_states` on the real driver (native and DuckDB-WASM): the column
 * types, the multi-row INSERT round trip, dedup and retention, and the
 * gate's idempotence property: ingesting a batch twice, or overlapping
 * batches, gives the same table.
 */

const BASE = 1_794_268_000_000;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassgrid-flights-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let stores = 0;
async function newStore(retentionMs: number | null = null): Promise<FlightStore> {
  stores += 1;
  return FlightStore.create(await testDriver(), { tempDirectory: join(dir, `s${stores}`), memoryLimitBytes: 256 * 1024 ** 2, retentionMs });
}

function fix(overrides: Partial<FlightPoint> = {}): FlightPoint {
  return {
    ts: BASE,
    hex: 'a1b2c3',
    flight: 'UAL123',
    registration: 'N12345',
    typeCode: 'B738',
    lat: 37.61234,
    lon: -122.38123,
    altBaroFt: 3_025,
    altGeomFt: 3_150,
    onGround: false,
    gsKt: 180.4,
    trackDeg: 280.1,
    baroRateFpm: -704,
    geomRateFpm: -640,
    category: 'A3',
    squawk: '4512',
    posType: 'adsb_icao',
    source: 'live',
    ...overrides,
  };
}

describe('flight_states', () => {
  it('has the fixtures’ column types', async () => {
    const store = await newStore();
    const connection = await store.connect();
    try {
      const described = await connection.query('DESCRIBE flight_states');
      expect(described.rows.map((row) => [row[0], row[1]])).toEqual([
        ['ts', 'TIMESTAMP'],
        ['hex', 'VARCHAR'],
        ['flight', 'VARCHAR'],
        ['registration', 'VARCHAR'],
        ['typeCode', 'VARCHAR'],
        ['lat', 'DECIMAL(7,5)'],
        ['lon', 'DECIMAL(8,5)'],
        ['altBaroFt', 'INTEGER'],
        ['altGeomFt', 'INTEGER'],
        ['onGround', 'BOOLEAN'],
        ['gsKt', 'DOUBLE'],
        ['trackDeg', 'DOUBLE'],
        ['baroRateFpm', 'INTEGER'],
        ['geomRateFpm', 'INTEGER'],
        ['category', 'VARCHAR'],
        ['squawk', 'VARCHAR'],
        ['posType', 'VARCHAR'],
        ['source', 'VARCHAR'],
      ]);
    } finally {
      connection.close();
      await store.close();
    }
  });

  it('stores what it is given at stored precision (nulls, quotes, separators and control characters included) over several INSERT statements', async () => {
    const store = await newStore();
    const points = Array.from({ length: ROWS_PER_INSERT + 7 }, (_, i) =>
      fix({
        ts: BASE + i * 5_000 + 0.4,
        lat: 37.612344 + i / 1e6,
        flight: i % 3 === 0 ? null : i % 3 === 1 ? `O'B${i % 1000}` : `A|\u001f${i % 100}`,
        altBaroFt: i % 2 === 0 ? null : 1_000.5 + i,
        onGround: i % 5 === 0,
        trackDeg: i === 1 ? 359.97 : 10 + i / 7,
        posType: i % 4 === 0 ? null : 'mlat',
      }),
    ).map((point) => ({ ...point, ts: Math.round(point.ts) }));
    const result = await store.ingest({ points, dataClockMs: BASE + 1_000_000 });
    expect(result).toEqual({ received: points.length, inserted: points.length, expired: 0, rowCount: points.length });
    const stored = await store.points();
    expect(stored).toEqual(points.map(toStoredPoint).sort((a, b) => a.ts - b.ts));
    expect(stored[1]?.trackDeg).toBe(0);
    expect(stored[2]?.flight).toBe('A|\ufffd2');
    await store.close();
  });

  it('drops exact repeats and re-reported live fixes, keeping the first report', async () => {
    const store = await newStore();
    await store.ingest({ points: [fix(), fix({ hex: 'a1b2c4' })], dataClockMs: BASE });
    // Next poll: the same fix seen 20 s later (seen_pos grew, now - seen_pos rounded 3 ms off), with a newer altitude.
    const again = await store.ingest({ points: [fix({ ts: BASE + 3, altBaroFt: 3_000 }), fix({ hex: 'a1b2c4' }), fix({ ts: BASE + 20_000, lat: 37.62 })], dataClockMs: BASE + 20_000 });
    expect(again).toMatchObject({ received: 3, inserted: 1 });
    expect((await store.points()).map((point) => [point.hex, point.ts, point.altBaroFt])).toEqual([
      ['a1b2c3', BASE, 3_025],
      ['a1b2c3', BASE + 20_000, 3_025],
      ['a1b2c4', BASE, 3_025],
    ]);
    // Archive rows at the same spot 3 ms apart are distinct fixes.
    await store.ingest({ points: [fix({ hex: 'b00001', source: 'archive' }), fix({ hex: 'b00001', ts: BASE + 3, source: 'archive' })], dataClockMs: BASE + 20_000 });
    expect(store.rowCount).toBe(5);
    await store.close();
  });

  it('keeps a rolling window behind the data clock', async () => {
    const store = await newStore(60 * 60_000);
    await store.ingest({ points: [fix({ ts: BASE }), fix({ ts: BASE + 30 * 60_000, lat: 37.7 })], dataClockMs: BASE + 30 * 60_000 });
    const later = await store.ingest({ points: [fix({ ts: BASE - 1, lat: 37.8 }), fix({ ts: BASE + 61 * 60_000, lat: 37.9 })], dataClockMs: BASE + 61 * 60_000 });
    // The fix at BASE fell out; the late one older than the window was never stored.
    expect(later).toEqual({ received: 2, inserted: 1, expired: 1, rowCount: 2 });
    expect((await store.points()).map((point) => point.ts)).toEqual([BASE + 30 * 60_000, BASE + 61 * 60_000]);
    await store.close();
  });

  it('leaves the table unchanged when a batch fails in a later INSERT statement', async () => {
    const store = await newStore();
    await store.ingest({ points: [fix()], dataClockMs: BASE });
    // The bad row is past ROWS_PER_INSERT, so the first statement has already inserted its rows when the second fails.
    const points = Array.from({ length: ROWS_PER_INSERT + 3 }, (_, i) => fix({ hex: 'b00001', ts: BASE + 10_000 + i * 5_000 }));
    const broken = points[ROWS_PER_INSERT + 1];
    if (!broken) throw new Error('no row');
    (broken as { hex: unknown }).hex = null;
    await expect(store.ingest({ points, dataClockMs: BASE })).rejects.toThrow();
    expect(await store.points()).toHaveLength(1);
    expect(store.rowCount).toBe(1);
    // And the store keeps working.
    await store.ingest({ points: [fix({ ts: BASE + 5_000, lat: 37.7 })], dataClockMs: BASE });
    expect(store.rowCount).toBe(2);
    await store.close();
  });

  it('stores an aircraft with an absurd altitude as null instead of rejecting the whole poll', async () => {
    const store = await newStore();
    const result = await store.ingest({ points: [fix({ altBaroFt: 3e9, baroRateFpm: -9e12 }), fix({ hex: 'a1b2c4' })], dataClockMs: BASE });
    expect(result).toMatchObject({ inserted: 2, rowCount: 2 });
    expect((await store.points())[0]).toMatchObject({ hex: 'a1b2c3', altBaroFt: null, baroRateFpm: null, altGeomFt: 3_150 });
    await store.close();
  });

  it('takes a fractional data clock (a replay position) without failing', async () => {
    const store = await newStore(60 * 60_000);
    const result = await store.ingest({ points: [fix()], dataClockMs: BASE + 0.5 });
    expect(result).toMatchObject({ inserted: 1, rowCount: 1 });
    await store.close();
  });
});

describe('retention and dedup together (property, real table)', () => {
  const RETENTION = 60_000;
  const liveArb: fc.Arbitrary<FlightPoint> = fc
    .record({ hex: fc.constantFrom('a00001', 'a00002'), ts: fc.integer({ min: 0, max: 40 }).map((step) => BASE + step * 100), lat: fc.constantFrom(37.6, 37.7) })
    .map((fields) => fix({ ...fields, lon: -122.4 }));
  // Each poll: some fixes and a data clock that puts the retention cutoff somewhere inside their range (rising, as clocks do).
  const pollsArb = fc
    .array(fc.record({ points: fc.array(liveArb, { minLength: 1, maxLength: 10 }), advance: fc.integer({ min: 0, max: 20 }) }), { minLength: 2, maxLength: 5 })
    .map((polls) => {
      let clock = BASE + RETENTION;
      return polls.map((poll) => ({ points: poll.points, clock: (clock += poll.advance * 100) }));
    });

  /** The rule in JS: expire, then dedup against what is left. */
  function model(polls: readonly { points: readonly FlightPoint[]; clock: number }[]): FlightPoint[] {
    let table: FlightPoint[] = [];
    for (const poll of polls) {
      const cutoff = poll.clock - RETENTION;
      table = table.filter((point) => point.ts >= cutoff);
      table.push(...newFixes(table, poll.points.map(toStoredPoint).filter((point) => point.ts >= cutoff)));
    }
    return table.sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : a.ts - b.ts));
  }

  it('keeps a re-report whose stored twin expires in the same batch', async () => {
    const store = await newStore(RETENTION);
    await store.ingest({ points: [fix({ ts: BASE })], dataClockMs: BASE + RETENTION });
    // Cutoff BASE + 1: the stored fix expires, its twin 500 ms later is still inside the window.
    await store.ingest({ points: [fix({ ts: BASE + 500 })], dataClockMs: BASE + RETENTION + 1 });
    expect((await store.points()).map((point) => point.ts)).toEqual([BASE + 500]);
    await store.close();
  });

  it('an expiring row never suppresses its near-twin: the table is the model', async () => {
    await fc.assert(
      fc.asyncProperty(pollsArb, async (polls) => {
        const store = await newStore(RETENTION);
        try {
          for (const poll of polls) await store.ingest({ points: poll.points, dataClockMs: poll.clock });
          expect(await store.points()).toEqual(model(polls));
        } finally {
          await store.close();
        }
      }),
      { seed: 20261113, numRuns: 40 },
    );
  });
});

describe('ingest is idempotent (property, real table)', () => {
  const pointArb: fc.Arbitrary<FlightPoint> = fc
    .record({
      hex: fc.constantFrom('a00001', 'a00002', '~b00003'),
      ts: fc.integer({ min: BASE, max: BASE + 8_000 }),
      // Positions with more decimals than stored, so rounding decides collisions as the table does.
      lat: fc.constantFrom(37.6, 37.600004, 37.600006, 37.7),
      lon: fc.constantFrom(-122.4, -122.400004, -122.3),
      altBaroFt: fc.option(fc.integer({ min: -1_000, max: 45_000 }), { nil: null }),
      gsKt: fc.option(fc.double({ min: 0, max: 600, noNaN: true }), { nil: null }),
      flight: fc.option(fc.constantFrom('UAL1', "O'NEIL", 'SWA2'), { nil: null }),
      source: fc.constantFrom('live' as const, 'archive' as const),
    })
    .map((fields) => fix({ ...fields, altGeomFt: null, onGround: fields.altBaroFt === null }));
  const batchArb = fc.array(pointArb, { maxLength: 25 });
  const RUNS = { seed: 20261112, numRuns: 20 };

  async function table(batches: readonly (readonly FlightPoint[])[]): Promise<FlightPoint[]> {
    const store = await newStore();
    try {
      for (const points of batches) await store.ingest({ points, dataClockMs: BASE + 10_000 });
      return await store.points();
    } finally {
      await store.close();
    }
  }

  /** What the rule says the table holds (dedup.ts on the stored-precision values), in the table's order. */
  function model(batches: readonly (readonly FlightPoint[])[]): FlightPoint[] {
    const kept: FlightPoint[] = [];
    for (const batch of batches) kept.push(...newFixes(kept, batch.map(toStoredPoint)));
    return kept.sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : a.ts - b.ts));
  }

  it('the same batch twice, or overlapping batches, give the same table', async () => {
    await fc.assert(
      fc.asyncProperty(batchArb, fc.nat(), batchArb, async (a, from, extra) => {
        const once = await table([a]);
        expect(once).toEqual(model([a]));
        expect(await table([a, a])).toEqual(once);
        const b = [...a.slice(a.length === 0 ? 0 : from % a.length), ...extra];
        const overlapping = await table([a, b]);
        expect(overlapping).toEqual(await table([[...a, ...extra]]));
        expect(overlapping).toEqual(model([a, b]));
      }),
      RUNS,
    );
  });
});

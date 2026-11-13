import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FLIGHT_POINT_FIELDS, LIVE_FIXTURES, type EngineEvent, type LiveClock, type LiveState } from '@glassgrid/core';
import type { DuckConnection } from '../driver';
import { createNativeDriver } from '../native/driver';
import { QueryService } from '../query-service';
import { quoteIdent, quoteLiteral } from '../sql-text';
import { isWasm } from '../test-support';
import { FLIGHT_POINT_SELECT, FLIGHT_STATES_TABLE, pointFromRow } from './flight-store';
import { memoryFixtureReader } from './replay-source';

/*
 * The L2 gate: replay the 30-minute fixture end to end (ReplaySource ->
 * dedup -> INSERT into flight_states, through QueryService's live feed) with
 * retention off, and show that `flight_states` holds exactly the fixture's
 * rows: the same count and the same value in every column.
 *
 * - native: the feed reads the Parquet file itself (parquetFixtureReader,
 *   through the feed's sandboxed database), and the check is SQL in that
 *   same database: EXCEPT ALL both ways against read_parquet(fixture).
 * - wasm: DuckDB-WASM's Node runtime has no Parquet extension here
 *   (docs/m4-web-demo.md), so the fixture's rows are read with native DuckDB
 *   and handed to the replay as a memory reader; ingest and the table are
 *   DuckDB-WASM's.
 *
 * Both then compare every cell as DuckDB's own text (CAST AS VARCHAR) of
 * flight_states against the fixture read independently by native DuckDB.
 */

const FIXTURE_ID = 'flights-bay-30min';
const FIXTURE = resolve(import.meta.dirname, '../../../../apps/web/public/samples/flights', LIVE_FIXTURES[FIXTURE_ID].file);

/** Timers that fire on the next macrotask while time jumps ahead by their delay: the replay runs as fast as ingest allows. */
function instantClock(start = 1_800_000_000_000): LiveClock {
  let now = start;
  return {
    now: () => now,
    setTimeout: (callback, ms) => {
      const due = now + ms;
      return setTimeout(() => {
        now = Math.max(now, due);
        callback();
      }, 0);
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

/** Every cell as text, rows ordered by (hex, ts): DuckDB's own rendering on both sides. */
function textRows(connection: DuckConnection, relation: string): Promise<string[][]> {
  const cells = FLIGHT_POINT_FIELDS.map((field) => `CAST(${quoteIdent(field)} AS VARCHAR)`).join(', ');
  return connection.query(`SELECT ${cells} FROM ${relation} ORDER BY hex, ts`).then((result) => result.rows.map((row) => row.map((cell) => (typeof cell === 'string' ? cell : cell === null ? '∅' : JSON.stringify(cell)))));
}

let dir: string;
let fixtureText: string[][];
const native = createNativeDriver();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'glassgrid-replay-'));
  const db = await native.createDatabase({ allowedPaths: [FIXTURE], allowedDirectories: [], tempDirectory: join(dir, 'reference'), memoryLimitBytes: 512 * 1024 ** 2 });
  const connection = await db.connect();
  fixtureText = await textRows(connection, `read_parquet(${quoteLiteral(FIXTURE)})`);
  connection.close();
  await db.close();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixturePoints() {
  const db = await native.createDatabase({ allowedPaths: [FIXTURE], allowedDirectories: [], tempDirectory: join(dir, 'points'), memoryLimitBytes: 512 * 1024 ** 2 });
  const connection = await db.connect();
  try {
    return (await connection.query(`SELECT ${FLIGHT_POINT_SELECT} FROM read_parquet(${quoteLiteral(FIXTURE)})`)).rows.map(pointFromRow);
  } finally {
    connection.close();
    await db.close();
  }
}

describe('replay gate: flights-bay-30min through ReplaySource into flight_states', () => {
  it('ends with exactly the fixture’s rows (retention off)', async () => {
    const { testDriver } = await import('../test-support');
    const driver = await testDriver();
    const reader = isWasm ? memoryFixtureReader(await fixturePoints()) : null;
    const service = await QueryService.create(driver, {
      cacheDir: join(dir, 'cache', 'parquet'),
      live: {
        clock: instantClock(),
        ...(reader ? { fixtureReader: () => Promise.resolve(reader) } : { fixturePath: () => Promise.resolve(FIXTURE) }),
      },
    });
    try {
      const states: LiveState[] = [];
      const ended = new Promise<void>((done) => {
        service.on('event', (event: EngineEvent) => {
          if (event.type !== 'liveState') return;
          states.push(event.state);
          if (event.state.feed?.ended) done();
        });
      });
      const started = performance.now();
      // 20 s ticks at 30x: 10 minutes of fixture per tick, so four ticks after the first cover the 31 minutes.
      const first = await service.live.start({ kind: 'replay', fixture: FIXTURE_ID, intervalMs: 20_000, speed: 30, retentionMs: null });
      expect(first.source).toEqual({ kind: 'replay', fixture: FIXTURE_ID, intervalMs: 20_000, speed: 30, retentionMs: null });
      await ended;
      const elapsedMs = performance.now() - started;

      const final = service.live.state();
      expect(final.feed).toMatchObject({ kind: 'replay', status: 'stopped', ended: true, failures: 0, error: null });
      expect(final.feed?.attribution).toContain('adsb.lol');
      expect(final.ingestError).toBeNull();
      expect(final.rowCount).toBe(LIVE_FIXTURES[FIXTURE_ID].rows);
      // Each batch was (previous tick, this tick]: received adds up to the fixture, nothing was a duplicate.
      const batches = states.flatMap((state, i) => (state.lastBatch && state.lastBatch !== states[i - 1]?.lastBatch ? [state.lastBatch] : []));
      expect(batches.map((batch) => batch.dataClockMs)).toEqual([0, 1, 2, 3, 4].map((k) => Date.parse('2026-11-09T23:27:00.000Z') + k * 600_000));
      expect(batches.reduce((sum, batch) => sum + batch.received, 0)).toBe(LIVE_FIXTURES[FIXTURE_ID].rows);
      expect(batches.every((batch) => batch.inserted === batch.received && batch.expired === 0)).toBe(true);

      const store = service.live.flightStore;
      if (!store) throw new Error('no store');
      const connection = await store.connect();
      try {
        const table = await textRows(connection, quoteIdent(FLIGHT_STATES_TABLE));
        expect(table.length).toBe(fixtureText.length);
        expect(table).toEqual(fixtureText);
        if (!isWasm) {
          const source = `read_parquet(${quoteLiteral(FIXTURE)})`;
          const missing = await connection.query(`SELECT count(*) FROM (SELECT * FROM ${source} EXCEPT ALL SELECT * FROM ${quoteIdent(FLIGHT_STATES_TABLE)})`);
          const extra = await connection.query(`SELECT count(*) FROM (SELECT * FROM ${quoteIdent(FLIGHT_STATES_TABLE)} EXCEPT ALL SELECT * FROM ${source})`);
          expect([Number(missing.rows[0]?.[0]), Number(extra.rows[0]?.[0])]).toEqual([0, 0]);
        }
      } finally {
        connection.close();
      }
      console.info(`[replay gate] ${isWasm ? 'wasm' : 'native'}: ${LIVE_FIXTURES[FIXTURE_ID].rows} rows in ${batches.length} batches, ${Math.round(elapsedMs)} ms`);
    } finally {
      service.close();
    }
  });
});

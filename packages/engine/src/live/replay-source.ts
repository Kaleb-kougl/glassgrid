import {
  ADSBLOL_ATTRIBUTION,
  ADSBLOL_LICENSE,
  DEFAULT_LIVE_INTERVAL_MS,
  MAX_REPLAY_SPEED,
  MIN_REPLAY_INTERVAL_MS,
  type FlightBatchSink,
  type FlightPoint,
  type LiveClock,
  type LiveSource,
  type LiveSourceState,
} from '@glassgrid/core';
import type { DuckConnection } from '../driver';
import { errorMessage } from '../errors';
import { quoteIdent, quoteLiteral } from '../sql-text';
import { systemClock } from './clock';
import { FLIGHT_POINT_SELECT, pointFromRow } from './flight-store';

/*
 * Replays a FlightPoint fixture on the live feed's tick clock
 * (docs/live-flights-l2.md, "Replay").
 *
 * The replay keeps its own position in fixture time. Tick k happens every
 * `intervalMs` of wall time and moves the position to
 *
 *     v_k = floor(startTs + k * intervalMs * speed)
 *
 * (floored to whole milliseconds: any speed is allowed, so the step need
 * not be an integer, and positions are epoch-ms values on the wire),
 * emitting the fixture's fixes with ts in (v_{k-1}, v_k] (tick 0 emits
 * everything up to `startTs`). The position advances by ticks, not by
 * reading the wall clock, so a late timer, a slow ingest or a pause never
 * skips or repeats fixes: the same fixture, interval and speed always give
 * the same batches. The tick after the one that reaches the last fix ends
 * the replay (`ended`, status `stopped`).
 */

/** Windows of a fixture, in time order. */
export interface FixtureReader {
  /** First and last fix time (epoch ms) and the row count; null for an empty fixture. */
  range(): Promise<{ firstTs: number; lastTs: number; rows: number } | null>;
  /** Fixes with afterTs < ts <= upToTs, ordered by (ts, hex). */
  read(afterTs: number, upToTs: number): Promise<FlightPoint[]>;
  close(): Promise<void>;
}

/** A reader over points held in memory (tests, and hosts that load a fixture themselves). */
export function memoryFixtureReader(points: readonly FlightPoint[]): FixtureReader {
  const sorted = [...points].sort((a, b) => a.ts - b.ts || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return {
    range: () => Promise.resolve(first && last ? { firstTs: first.ts, lastTs: last.ts, rows: sorted.length } : null),
    read: (afterTs, upToTs) => Promise.resolve(sorted.filter((point) => point.ts > afterTs && point.ts <= upToTs)),
    close: () => Promise.resolve(),
  };
}

const FIXTURE_TABLE = quoteIdent('gg_replay_fixture');

/**
 * A reader over a fixture Parquet file, through the feed's own database
 * (whose allowlist holds the file). The file is copied once into a table
 * ordered by time, so each tick is a range scan of memory instead of a
 * re-read of the (hex, ts)-sorted, zstd-compressed file.
 */
export async function parquetFixtureReader(connection: DuckConnection, path: string): Promise<FixtureReader> {
  // CREATE TABLE ... AS cannot take bound values; the path is the host's, never a request's.
  await connection.run(`CREATE OR REPLACE TABLE ${FIXTURE_TABLE} AS SELECT * FROM read_parquet(${quoteLiteral(path)}) ORDER BY ts, hex`);
  return {
    async range() {
      const row = (await connection.query(`SELECT epoch_ms(min(ts)), epoch_ms(max(ts)), count(*) FROM ${FIXTURE_TABLE}`)).rows[0];
      if (!row || row[0] === null || row[0] === undefined) return null;
      return { firstTs: Number(row[0]), lastTs: Number(row[1]), rows: Number(row[2]) };
    },
    async read(afterTs, upToTs) {
      const result = await connection.query(
        `SELECT ${FLIGHT_POINT_SELECT} FROM ${FIXTURE_TABLE} WHERE ts > epoch_ms(CAST(? AS BIGINT)) AND ts <= epoch_ms(CAST(? AS BIGINT)) ORDER BY ts, hex`,
        [BigInt(Math.max(-1, Math.floor(afterTs))), BigInt(Math.floor(upToTs))],
      );
      return result.rows.map(pointFromRow);
    },
    async close() {
      await connection.run(`DROP TABLE IF EXISTS ${FIXTURE_TABLE}`).catch(() => undefined);
      connection.close();
    },
  };
}

export interface ReplaySourceOptions {
  reader: FixtureReader;
  sink: FlightBatchSink;
  /** Called after every state change. */
  onState?: (state: LiveSourceState) => void;
  /** Wall time between ticks (default 20 s, at least 1 s). */
  intervalMs?: number;
  /** Fixture time per wall time (default 1, at most MAX_REPLAY_SPEED). */
  speed?: number;
  /** Fixture time of tick 0 (default: the first fix). */
  startTs?: number;
  clock?: LiveClock;
  attribution?: string;
  license?: string;
}

export class ReplaySource implements LiveSource {
  readonly kind = 'replay';
  private readonly clock: LiveClock;
  private readonly intervalMs: number;
  private readonly speed: number;
  private current: LiveSourceState;
  private range: { firstTs: number; lastTs: number } | null = null;
  /** Ticks done; the next one is tick `ticks`. */
  private ticks = 0;
  private timer: unknown = null;
  private running = false;
  private paused = false;
  /** Bumped by stop() so a tick in flight never schedules another. */
  private generation = 0;
  private busy = false;

  constructor(private readonly options: ReplaySourceOptions) {
    this.clock = options.clock ?? systemClock;
    this.intervalMs = Math.max(MIN_REPLAY_INTERVAL_MS, options.intervalMs ?? DEFAULT_LIVE_INTERVAL_MS);
    this.speed = Math.min(MAX_REPLAY_SPEED, Math.max(1, options.speed ?? 1));
    this.current = {
      kind: 'replay',
      status: 'stopped',
      paused: false,
      attribution: options.attribution ?? ADSBLOL_ATTRIBUTION,
      license: options.license ?? ADSBLOL_LICENSE,
      lastSuccessAt: null,
      dataClockMs: null,
      nextAttemptAt: null,
      failures: 0,
      error: null,
      ended: false,
    };
  }

  state(): LiveSourceState {
    return this.current;
  }

  /** Fixture time per tick. */
  get stepMs(): number {
    return this.intervalMs * this.speed;
  }

  start(): void {
    if (this.running || this.current.ended) return;
    this.running = true;
    this.update({ status: 'connecting', error: null });
    if (!this.paused) this.schedule(0);
  }

  stop(): void {
    if (!this.running && this.current.status === 'stopped') return;
    this.running = false;
    this.generation += 1;
    this.cancelTimer();
    this.update({ status: 'stopped', nextAttemptAt: null });
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.cancelTimer();
    this.update({ paused: true, nextAttemptAt: null });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.update({ paused: false });
    // A tick in flight schedules the next one itself.
    if (this.running && !this.busy) this.schedule(this.ticks === 0 ? 0 : this.intervalMs);
  }

  /** The fixture position of tick k. */
  private positionOf(tick: number, range: { firstTs: number }): number {
    // Floored to whole ms: `intervalMs * speed` need not be an integer (speed 1.0005), and positions are epoch ms.
    return Math.floor((this.options.startTs ?? range.firstTs) + tick * this.stepMs);
  }

  /** Schedule the next tick; `patch` is reported in the same state change. */
  private schedule(delayMs: number, patch: Partial<LiveSourceState> = {}): void {
    this.cancelTimer();
    const generation = this.generation;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.tick(generation);
    }, delayMs);
    this.update({ ...patch, nextAttemptAt: this.clock.now() + delayMs });
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(generation: number): Promise<void> {
    if (!this.running || this.paused || generation !== this.generation) return;
    this.busy = true;
    try {
      this.range ??= await this.options.reader.range();
      const range = this.range;
      if (range === null) {
        this.finish();
        return;
      }
      const upTo = this.positionOf(this.ticks, range);
      const after = this.ticks === 0 ? range.firstTs - 1 : this.positionOf(this.ticks - 1, range);
      const points = await this.options.reader.read(after, upTo);
      if (generation !== this.generation) return;
      await this.options.sink({ points, dataClockMs: upTo }).catch(() => undefined);
      if (generation !== this.generation) return;
      this.ticks += 1;
      const done = { status: 'live' as const, lastSuccessAt: this.clock.now(), dataClockMs: upTo, failures: 0, error: null };
      if (upTo >= range.lastTs) this.finish(done);
      else if (this.active()) this.schedule(this.intervalMs, done);
      else this.update(done);
    } catch (error) {
      if (generation !== this.generation) return;
      // The reader failed (the fixture's database closed, a read error): retry the same tick later.
      const failed = { status: 'backoff' as const, failures: this.current.failures + 1, error: errorMessage(error) };
      if (this.active()) this.schedule(this.intervalMs, failed);
      else this.update(failed);
    } finally {
      this.busy = false;
    }
  }

  /** Running and not paused (read through a method: both change while a tick awaits). */
  private active(): boolean {
    return this.running && !this.paused;
  }

  private finish(patch: Partial<LiveSourceState> = {}): void {
    this.running = false;
    this.generation += 1;
    this.cancelTimer();
    this.update({ ...patch, status: 'stopped', ended: true, nextAttemptAt: null });
  }

  private update(patch: Partial<LiveSourceState>): void {
    this.current = { ...this.current, ...patch };
    this.options.onState?.(this.current);
  }
}

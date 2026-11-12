import { z } from 'zod';
import type { FlightPoint } from './point.js';

/*
 * Live flights: the contract between a source of flight fixes and the
 * engine that ingests them (milestone L2, docs/live-flights-l2.md).
 *
 * Two sources share one interface (`LiveSource`, implemented in
 * `packages/engine/src/live`):
 *
 * - `live`: polls a same-origin endpoint (`GET /api/flights` on the
 *   portfolio site) that relays adsb.lol's aircraft over the Bay Area box;
 *   the endpoint's body is `FlightsApiResponseSchema`;
 * - `replay`: plays one of the committed Parquet fixtures
 *   (`LIVE_FIXTURES`) on the same tick clock, deterministically;
 * - `archive` (L4, docs/live-flights-l4.md): loads a whole fixture at once
 *   (retention off), for the time scrubber to replay as a view parameter
 *   ("as of T") instead of re-ingesting on every seek.
 *
 * Both emit batches of `FlightPoint` and report a `LiveSourceState`. This
 * file holds only types, schemas and constants, so the app, the protocol and
 * the engine agree on them.
 */

// ---------------------------------------------------------------------------
// Attribution

/** adsb.lol's data licence (the archive's README and the live API alike). */
export const ADSBLOL_LICENSE = 'ODbL-1.0';

/** The attribution line the fixtures' manifest carries; shown with every view of the data. */
export const ADSBLOL_ATTRIBUTION = 'Data © adsb.lol contributors, licensed under the Open Database License (ODbL) 1.0';

// ---------------------------------------------------------------------------
// Cadence

/**
 * Default poll and tick interval: 20 s. The endpoint is served through a CDN
 * that caches for 10 s (`s-maxage=10`), so polling faster than 10 s only
 * returns the same body again, and every request counts against the site's
 * CDN budget (Vercel Hobby: 1M requests a month). One viewer at 10 s makes
 * 360 requests an hour; 20 s halves that. See docs/live-flights-l2.md.
 */
export const DEFAULT_LIVE_INTERVAL_MS = 20_000;

/** Fastest live poll: the CDN's cache window (`s-maxage=10`). */
export const MIN_LIVE_INTERVAL_MS = 10_000;

/** Fastest replay tick (no network involved). */
export const MIN_REPLAY_INTERVAL_MS = 1_000;

/** Slowest poll or tick anyone may ask for. */
export const MAX_LIVE_INTERVAL_MS = 10 * 60_000;

/**
 * A live source with no successful update for longer than this reports
 * `stale`, or longer than one interval plus the request timeout and a
 * margin when that is more (a 60 s interval must not flicker to `stale`
 * between polls).
 */
export const LIVE_STALE_AFTER_MS = 30_000;

/** The margin on top of interval + timeout before a slow-polling source counts as stale. */
export const LIVE_STALE_MARGIN_MS = 2_000;

/**
 * How far the relay's `now` may run ahead of this machine's clock before it
 * is clamped for retention. A relay clock hours ahead would otherwise make
 * every stored fix look expired and empty the table.
 */
export const MAX_LIVE_CLOCK_AHEAD_MS = 5_000;

/** Rolling retention of `flight_states` for the live source (default; configurable per start). */
export const DEFAULT_LIVE_RETENTION_MS = 60 * 60_000;

/** Longest retention a caller may ask for: one day, the length of the day fixture. */
export const MAX_LIVE_RETENTION_MS = 24 * 60 * 60_000;

/** Replay speed multipliers allowed: 1x (real time) to 120x (40 minutes of fixture per 20 s tick). */
export const MAX_REPLAY_SPEED = 120;

/**
 * Re-reported live fixes: the same position fix of the same aircraft, seen
 * again on a later poll, is reported with `seen_pos` measured from a later
 * `now`, so its fix time (`now - seen_pos`) can differ by the rounding of
 * both. Two live fixes of one aircraft at the identical stored position
 * whose times differ by at most this much are treated as one fix (see the
 * ingest notes in docs/live-flights-l2.md).
 */
export const LIVE_FIX_TOLERANCE_MS = 2_000;

// ---------------------------------------------------------------------------
// Replay fixtures

/** The committed fixtures (apps/web/public/samples/flights/, ODbL 1.0) a replay can play. */
export const LIVE_FIXTURES = Object.freeze({
  'flights-bay-30min': Object.freeze({ file: 'flights-bay-30min.parquet', label: 'Bay Area, busiest 30 minutes of 2026-11-09', rows: 71_595 }),
  'flights-bay-day': Object.freeze({ file: 'flights-bay-day.parquet', label: 'Bay Area, all of 2026-11-09 (UTC)', rows: 1_456_777 }),
});
export const LiveFixtureIdSchema = z.enum(['flights-bay-30min', 'flights-bay-day']);
export type LiveFixtureId = z.infer<typeof LiveFixtureIdSchema>;

/** The recording offered in place of an unavailable live feed (L5), and fetched ahead when a live feed starts so it loads offline. */
export const LIVE_FALLBACK_FIXTURE: LiveFixtureId = 'flights-bay-30min';

// ---------------------------------------------------------------------------
// Source configuration

const RetentionSchema = z
  .number()
  .int()
  .min(60_000)
  .max(MAX_LIVE_RETENTION_MS)
  .nullable()
  .describe('Rolling retention of flight_states in ms (fixes older than the source clock minus this are dropped); null keeps everything');

export const LiveFeedConfigSchema = z.strictObject({
  kind: z.literal('live'),
  /** Poll interval in ms (default 20 s; at least 10 s, the CDN's cache window). */
  intervalMs: z.number().int().min(MIN_LIVE_INTERVAL_MS).max(MAX_LIVE_INTERVAL_MS).optional(),
  /** Default `DEFAULT_LIVE_RETENTION_MS`. */
  retentionMs: RetentionSchema.optional(),
});

export const ReplayFeedConfigSchema = z.strictObject({
  kind: z.literal('replay'),
  fixture: LiveFixtureIdSchema,
  /** Tick interval in ms (default 20 s, like the live poll). */
  intervalMs: z.number().int().min(MIN_REPLAY_INTERVAL_MS).max(MAX_LIVE_INTERVAL_MS).optional(),
  /**
   * Fixture time per wall-clock time (default 1: real time). Any value in
   * range: `intervalMs * speed` need not be whole, and the replay floors
   * each position to whole milliseconds (epoch-ms values everywhere).
   */
  speed: z.number().min(1).max(MAX_REPLAY_SPEED).optional(),
  /** Default `DEFAULT_LIVE_RETENTION_MS`; null keeps the whole fixture. */
  retentionMs: RetentionSchema.optional(),
});

/**
 * A whole fixture loaded at once (L4): one batch, retention off, ordered by
 * time; the app's time cursor then moves through it ("as of T") without
 * touching the table again. Its state is `live` once loaded.
 */
export const ArchiveFeedConfigSchema = z.strictObject({
  kind: z.literal('archive'),
  fixture: LiveFixtureIdSchema,
});

/** Which source feeds `flight_states`, and how. */
export const LiveSourceConfigSchema = z.discriminatedUnion('kind', [LiveFeedConfigSchema, ReplayFeedConfigSchema, ArchiveFeedConfigSchema]);
export type LiveSourceConfig = z.infer<typeof LiveSourceConfigSchema>;
export type LiveSourceConfigInput = z.input<typeof LiveSourceConfigSchema>;
export type LiveSourceKind = LiveSourceConfig['kind'];

/** The same source: same kind and, for a replay or an archive, the same fixture (interval and speed may differ). */
export function sameLiveSource(a: LiveSourceConfig, b: LiveSourceConfig): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'live' || b.kind === 'live') return true;
  return a.fixture === b.fixture;
}

// ---------------------------------------------------------------------------
// Status

/**
 * - `connecting`: started, no batch yet (first poll in flight, fixture loading);
 * - `live`: the last poll or tick succeeded and is recent;
 * - `stale`: the endpoint says its data is stale (`stale: true`), or nothing
 *   succeeded for more than `LIVE_STALE_AFTER_MS`;
 * - `backoff`: the last attempt failed (or the endpoint answered 503); the
 *   next one waits (`nextAttemptAt`);
 * - `rate-limited` (L5): the endpoint answered 429, or a 503 whose `reason`
 *   is the upstream's `HTTP 429`; the next attempt waits for its
 *   `Retry-After` (`nextAttemptAt`). Counted in `failures` like a backoff;
 * - `stopped`: not running (never started, stopped, or a replay that ended).
 *
 * Pausing (the page is hidden) is not a status: `paused` is reported beside
 * it, and nothing is fetched or ticked while it is true.
 */
export const LIVE_STATUSES = ['connecting', 'live', 'stale', 'backoff', 'rate-limited', 'stopped'] as const;
export const LiveStatusSchema = z.enum(LIVE_STATUSES);
export type LiveStatus = z.infer<typeof LiveStatusSchema>;

const epochMs = z.number().int().nonnegative();

/** What a source reports about itself. */
export const LiveSourceStateSchema = z.object({
  kind: z.enum(['live', 'replay', 'archive']),
  status: LiveStatusSchema,
  /** No polls or ticks while the page is hidden. */
  paused: z.boolean(),
  /** The attribution line to show with the data (from the endpoint, or the fixture's licence). */
  attribution: z.string().nullable(),
  license: z.string().nullable(),
  /** Wall-clock time of the last successful poll or tick. */
  lastSuccessAt: epochMs.nullable(),
  /** The data clock of the last batch: the endpoint's `now`, or the replay's position in the fixture. */
  dataClockMs: epochMs.nullable(),
  /** When the next poll or tick is due (wall clock), if one is scheduled. */
  nextAttemptAt: epochMs.nullable(),
  /** Failed attempts in a row. */
  failures: z.number().int().nonnegative(),
  /**
   * How long the source decided to wait after its last failure (ms: Retry-After or the backoff), so a reader can
   * judge the wait without a clock of its own (L5's offer of recorded traffic); null after a success. Live source only.
   */
  retryDelayMs: z.number().int().nonnegative().nullable().optional(),
  /** The last failure, cleared by the next success. */
  error: z.string().nullable(),
  /** A replay played its whole fixture (an archive, which never plays, is never `ended`). */
  ended: z.boolean(),
});
export type LiveSourceState = z.infer<typeof LiveSourceStateSchema>;

/** What the engine reports about the live feed: the source's state plus what was ingested. */
export const LiveStateSchema = z.object({
  /** The configured source, or null before the first start. */
  source: LiveSourceConfigSchema.nullable(),
  /** The running (or last) source's state, or null before the first start. */
  feed: LiveSourceStateSchema.nullable(),
  /** Rows in `flight_states` now. */
  rowCount: z.number().int().nonnegative(),
  /** The last batch: fixes received, new rows kept, rows removed by retention. */
  lastBatch: z
    .object({
      received: z.number().int().nonnegative(),
      inserted: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative(),
      dataClockMs: epochMs,
    })
    .nullable(),
  /** The last ingest failure, cleared by the next successful batch. */
  ingestError: z.string().nullable(),
});
export type LiveState = z.infer<typeof LiveStateSchema>;

export const INITIAL_LIVE_STATE: LiveState = Object.freeze({ source: null, feed: null, rowCount: 0, lastBatch: null, ingestError: null });

// ---------------------------------------------------------------------------
// The live endpoint

/** Most aircraft one response may carry (the Bay Area peaks under 200). */
export const MAX_API_AIRCRAFT = 5_000;

/**
 * `GET /api/flights`: adsb.lol's aircraft over the Bay Area box, relayed by
 * the portfolio site (cached by the CDN for 10 s; 503 with `Retry-After`
 * when it has no data). Aircraft objects are readsb's (`hex`, `flight`,
 * `lat`, `lon`, `alt_baro` in ft or `"ground"`, `alt_geom`, `gs`, `track`,
 * `baro_rate`, `geom_rate`, `category`, `squawk`, `seen`, `seen_pos`,
 * `type`) and are mapped one by one with `fromReadsbAircraft`, so a
 * malformed aircraft drops only itself; the envelope is validated here.
 */
export const FlightsApiResponseSchema = z.object({
  /** The upstream snapshot's time, epoch **milliseconds** (`seen_pos` is relative to it). */
  now: z.number().int().positive(),
  /** When the relay fetched it, epoch ms. */
  fetchedAt: z.number().int().positive(),
  /** The relay could not refresh and serves an older snapshot. */
  stale: z.boolean(),
  source: z.literal('adsb.lol'),
  attribution: z.string().min(1).max(500),
  license: z.string().min(1).max(100),
  ac: z.array(z.unknown()).max(MAX_API_AIRCRAFT),
});
export type FlightsApiResponse = z.infer<typeof FlightsApiResponseSchema>;

/** The endpoint's path on the site's origin (not under the app's `/glassgrid/` base). */
export const LIVE_FLIGHTS_PATH = '/api/flights';

/** `https://site/api/flights` for a page on `origin`. */
export function liveFlightsUrl(origin: string): string {
  return new URL(LIVE_FLIGHTS_PATH, origin).href;
}

// ---------------------------------------------------------------------------
// The source interface

/** Fixes from one poll or tick. */
export interface FlightBatch {
  readonly points: readonly FlightPoint[];
  /** The data clock: the endpoint's `now` (live) or the replay position (fixture time); retention counts back from it. */
  readonly dataClockMs: number;
}

/** Timers and time, injected so sources run under fake clocks in tests. */
export interface LiveClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * A source of flight fixes. `start` begins polling or ticking and delivers
 * each batch to the sink it was created with, waiting for the sink before
 * the next poll or tick (so batches never overlap); `pause` / `resume` hold
 * and continue it without losing its place (the page was hidden); `stop`
 * ends it. All are idempotent.
 */
export interface LiveSource {
  readonly kind: LiveSourceKind;
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  state(): LiveSourceState;
}

/**
 * Where a source delivers batches. The source waits for it, and a rejection
 * does not stop the source (the engine reports ingest failures itself, in
 * `LiveState.ingestError`).
 */
export type FlightBatchSink = (batch: FlightBatch) => Promise<void>;

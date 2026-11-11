import {
  DEFAULT_LIVE_RETENTION_MS,
  INITIAL_LIVE_STATE,
  sameLiveSource,
  type FlightBatch,
  type LiveClock,
  type LiveFixtureId,
  type LiveSource,
  type LiveSourceConfig,
  type LiveSourceState,
  type LiveState,
} from '@glassgrid/core';
import type { DuckDriver } from '../driver';
import { EngineFailure, errorMessage } from '../errors';
import { AdsbLolSource, type LiveFetch } from './adsblol-source';
import { ArchiveSource } from './archive-source';
import { FlightStore, type IngestResult } from './flight-store';
import { ReplaySource, parquetFixtureReader, type FixtureReader } from './replay-source';

/*
 * The engine's live feed: one source (live or replay) feeding one
 * `flight_states` table, shared by every connection to the engine
 * (docs/live-flights-l2.md). QueryService owns it (`service.live`) and
 * EngineSession routes the `live*` requests to it.
 *
 * - Sources: the live endpoint, a fixture replayed tick by tick, or (L4) a
 *   whole fixture loaded at once (`archive`: one batch, retention off; the
 *   app's time cursor then moves through it, docs/live-flights-l4.md).
 * - `start(config)` runs `config`; `setSource(config)` chooses it and
 *   switches only a running feed; `stop()` stops. Each answers the new
 *   `LiveState`, and every change is reported through `onState` (the
 *   engine's `liveState` event).
 * - The table is emptied (a new store) when the source changes (another
 *   kind, another fixture) and whenever a replay starts over, so live and
 *   replayed fixes never mix and a replay always matches its fixture.
 *   Restarting the same live source keeps its rows (and its retention
 *   still applies).
 * - Visibility: the feed pauses while every connection that reported its
 *   visibility is hidden (`setVisible`), and resumes as soon as one is
 *   visible again or the hidden ones disconnect (`releaseHolder`).
 * - Control calls run one at a time, in order.
 */

export interface LiveFeedHostOptions {
  /** The live endpoint (web: `liveFlightsUrl(location.origin)`); without it the live source is `not_implemented`. */
  url?: string;
  fetch?: LiveFetch;
  /** A replay fixture's path on the driver's file system; without it (and `fixtureReader`) replay is `not_implemented`. */
  fixturePath?: (fixture: LiveFixtureId) => Promise<string>;
  /** Supplies a fixture's fixes directly instead of reading its Parquet file (tests; drivers without Parquet). */
  fixtureReader?: (fixture: LiveFixtureId) => Promise<FixtureReader>;
  clock?: LiveClock;
  random?: () => number;
  /** Re-reported live fix tolerance (default LIVE_FIX_TOLERANCE_MS). */
  toleranceMs?: number;
}

export interface LiveFeedOptions extends LiveFeedHostOptions {
  driver: DuckDriver;
  /** Spill folder of the feed's database (native). */
  tempDirectory: string;
  memoryLimitBytes: number;
  onState?: (state: LiveState) => void;
  /**
   * A batch was committed to `store`. Awaited before the batch is reported
   * (`onState`), so whoever re-queries on the report sees the new rows and
   * no cached result from before it (QueryService versions the live table
   * here, docs/live-flights-l3-data.md). A rejection is ignored.
   */
  onIngested?: (store: FlightStore) => Promise<void> | void;
  /** `store` is about to be closed (another source, or shutdown); awaited first. A rejection is ignored. */
  onStoreClosing?: (store: FlightStore) => Promise<void> | void;
}

interface Running {
  config: LiveSourceConfig;
  source: LiveSource;
  reader: FixtureReader | null;
}

export class LiveFeed {
  private config: LiveSourceConfig | null = null;
  private store: FlightStore | null = null;
  /** The config the store was made for (its retention and source). */
  private storeConfig: LiveSourceConfig | null = null;
  private running: Running | null = null;
  /** The last source's final state, once it is gone. */
  private lastFeed: LiveSourceState | null = null;
  private lastBatch: LiveState['lastBatch'] = null;
  private ingestError: string | null = null;
  /**
   * When the endpoint was last polled, by whichever live source: a new
   * source (a restart, another interval) waits MIN_LIVE_INTERVAL_MS after
   * it, so no sequence of commands polls faster than the CDN window.
   */
  private lastLivePollAt: number | null = null;
  private readonly visibility = new Map<string, boolean>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: LiveFeedOptions) {}

  /** Whether a source kind is configured on this host. */
  supports(kind: LiveSourceConfig['kind']): boolean {
    // A replay and an archive read the same fixtures.
    return kind === 'live' ? this.options.url !== undefined : this.options.fixturePath !== undefined || this.options.fixtureReader !== undefined;
  }

  state(): LiveState {
    if (this.config === null) return INITIAL_LIVE_STATE;
    return {
      source: this.config,
      feed: this.running?.source.state() ?? this.lastFeed,
      rowCount: this.store?.rowCount ?? 0,
      lastBatch: this.lastBatch,
      ingestError: this.ingestError,
    };
  }

  /** The current `flight_states` store (null before the first start). */
  get flightStore(): FlightStore | null {
    return this.store;
  }

  /** Resolves once the control calls queued so far (a start, a switch) are done, whatever their outcome. */
  idle(): Promise<void> {
    return this.queue.then(
      () => undefined,
      () => undefined,
    );
  }

  start(config: LiveSourceConfig): Promise<LiveState> {
    return this.serial(async () => {
      this.check(config);
      const running = this.running;
      // Already running exactly this (a replay that played to its end starts over).
      if (running && sameConfig(running.config, config) && running.source.state().status !== 'stopped') return this.state();
      await this.run(config);
      return this.state();
    });
  }

  setSource(config: LiveSourceConfig): Promise<LiveState> {
    return this.serial(async () => {
      this.check(config);
      if (this.running && this.running.source.state().status !== 'stopped') {
        if (!sameConfig(this.running.config, config)) await this.run(config);
        return this.state();
      }
      // Not running (or a replay that ended): only choose.
      await this.halt();
      if (this.config && !sameLiveSource(this.config, config)) {
        // Another source: neither the old table nor the old source's state describe it.
        await this.resetStore();
        this.lastFeed = null;
      }
      this.config = config;
      this.emit();
      return this.state();
    });
  }

  stop(): Promise<LiveState> {
    return this.serial(async () => {
      await this.halt();
      this.emit();
      return this.state();
    });
  }

  /** A connection's page or window became visible or hidden. */
  setVisible(holder: string, visible: boolean): void {
    this.visibility.set(holder, visible);
    this.applyVisibility();
  }

  /** A connection went away: its visibility no longer counts. */
  releaseHolder(holder: string): void {
    if (this.visibility.delete(holder)) this.applyVisibility();
  }

  /** True while every connection that reported is hidden. */
  get paused(): boolean {
    return this.visibility.size > 0 && ![...this.visibility.values()].some(Boolean);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    // Runs after the control calls already queued; later ones are refused.
    const done = this.queue.then(async () => {
      await this.halt();
      await this.resetStore();
    });
    this.queue = done.catch(() => undefined);
    return this.queue as Promise<void>;
  }

  private check(config: LiveSourceConfig): void {
    if (!this.supports(config.kind)) {
      throw new EngineFailure(
        'not_implemented',
        config.kind === 'live' ? 'Live flight data is not configured in this app' : config.kind === 'archive' ? 'Recorded flight data is not available in this app' : 'Flight replays are not available in this app',
      );
    }
  }

  /** Stop what runs and start `config`, on a fresh table unless it is the same live source. */
  private async run(config: LiveSourceConfig): Promise<void> {
    await this.halt();
    const keep = this.store !== null && this.storeConfig !== null && config.kind === 'live' && sameLiveSource(this.storeConfig, config) && retentionOf(this.storeConfig) === retentionOf(config);
    if (!keep) await this.resetStore();
    this.config = config;
    this.lastBatch = keep ? this.lastBatch : null;
    this.ingestError = null;
    let reader: FixtureReader | null = null;
    try {
      const store = this.store ?? (await this.newStore(config));
      if (config.kind === 'replay') reader = await this.openReader(config.fixture, store);
      const source = this.newSource(config, store, reader);
      this.running = { config, source, reader };
      if (this.paused) source.pause();
      source.start();
    } catch (error) {
      await reader?.close().catch(() => undefined);
      // Rows the caller asked to keep (the same live source) stay; a half-made new table goes, and an empty one
      // takes its place, so the live table reads as no rows (not the old source's, nor an error) until a retry.
      if (!keep) {
        await this.resetStore();
        await this.newStore(config, false).catch(() => undefined);
      }
      const what = config.kind === 'live' ? 'live feed' : config.kind === 'archive' ? 'recorded day' : 'replay';
      const failure = error instanceof EngineFailure ? error : new EngineFailure('io_failed', `The ${what} could not start: ${errorMessage(error)}`, { cause: error });
      // The state says so too (stopped, with the error), so a view of it can offer to retry rather than wait.
      this.lastFeed = stoppedFeed(config, failure.message);
      this.emit();
      throw failure;
    }
    this.emit();
  }

  /** A new, empty store for `config`, allowed to read its fixture (`withFixture`) or nothing (one standing in for a source that failed to start). */
  private async newStore(config: LiveSourceConfig, withFixture = true): Promise<FlightStore> {
    const fixturePath = withFixture && config.kind !== 'live' && this.options.fixtureReader === undefined ? await this.options.fixturePath?.(config.fixture) : undefined;
    const store = await FlightStore.create(this.options.driver, {
      allowedPaths: fixturePath === undefined ? [] : [fixturePath],
      tempDirectory: this.options.tempDirectory,
      memoryLimitBytes: this.options.memoryLimitBytes,
      retentionMs: retentionOf(config),
      ...(this.options.toleranceMs === undefined ? {} : { toleranceMs: this.options.toleranceMs }),
    });
    this.store = store;
    this.storeConfig = config;
    return store;
  }

  private async openReader(fixture: LiveFixtureId, store: FlightStore): Promise<FixtureReader> {
    if (this.options.fixtureReader) return this.options.fixtureReader(fixture);
    const path = await this.options.fixturePath?.(fixture);
    if (path === undefined) throw new EngineFailure('not_implemented', 'Flight replays are not available in this app');
    if (!this.options.driver.capabilities.parquet) throw new EngineFailure('not_implemented', 'Flight replays need Parquet, which is not available here');
    return parquetFixtureReader(await store.connect(), path);
  }

  private newSource(config: LiveSourceConfig, store: FlightStore, reader: FixtureReader | null): LiveSource {
    const sink = (batch: FlightBatch) => this.ingest(store, batch);
    const onState = () => this.emit();
    const clock = this.options.clock === undefined ? {} : { clock: this.options.clock };
    if (config.kind === 'archive') {
      const fixture = config.fixture;
      return new ArchiveSource({ load: () => this.loadArchive(store, fixture), onState, ...clock });
    }
    const interval = config.intervalMs === undefined ? {} : { intervalMs: config.intervalMs };
    if (config.kind === 'live') {
      const url = this.options.url;
      if (url === undefined) throw new EngineFailure('not_implemented', 'Live flight data is not configured in this app');
      return new AdsbLolSource({
        url,
        sink,
        onState,
        ...clock,
        ...interval,
        ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
        ...(this.options.random === undefined ? {} : { random: this.options.random }),
        lastPollAt: this.lastLivePollAt,
      });
    }
    if (reader === null) throw new EngineFailure('not_implemented', 'Flight replays are not available in this app');
    return new ReplaySource({ reader, sink, onState, ...clock, ...interval, ...(config.speed === undefined ? {} : { speed: config.speed }) });
  }

  /**
   * An archive's one load (L4): the fixture's Parquet file straight into the
   * empty store (`loadParquet`), or, for a fixture held in memory (tests,
   * hosts without Parquet), every fix as one batch. Reported like a batch
   * (versioned by QueryService, then `lastBatch`); a failure throws, so the
   * source reports it (and retries unless it cannot succeed). A failed load
   * leaves the table empty (its INSERT rolled back) and still versions it,
   * so nothing cached while it loaded outlives it. Resolves with the last
   * fix time.
   */
  private async loadArchive(store: FlightStore, fixture: LiveFixtureId): Promise<number | null> {
    try {
      return await this.loadArchiveRows(store, fixture);
    } catch (error) {
      if (store === this.store) await Promise.resolve(this.options.onIngested?.(store)).catch(() => undefined);
      throw error;
    }
  }

  private async loadArchiveRows(store: FlightStore, fixture: LiveFixtureId): Promise<number | null> {
    if (this.options.fixtureReader) {
      const reader = await this.options.fixtureReader(fixture);
      try {
        const range = await reader.range();
        if (range === null) return null;
        const points = await reader.read(range.firstTs - 1, range.lastTs);
        const result = await store.ingest({ points, dataClockMs: range.lastTs });
        await this.recordBatch(store, result, range.lastTs);
        return range.lastTs;
      } finally {
        await reader.close().catch(() => undefined);
      }
    }
    const path = await this.options.fixturePath?.(fixture);
    if (path === undefined) throw new EngineFailure('not_implemented', 'Recorded flight data is not available in this app');
    if (!this.options.driver.capabilities.parquet) throw new EngineFailure('not_implemented', 'Recorded flight data needs Parquet, which is not available here');
    const result = await store.loadParquet(path);
    if (result.lastTs !== null) await this.recordBatch(store, result, result.lastTs);
    return result.lastTs;
  }

  /** A batch committed to `store`: version the live table (awaited), then report it. */
  private async recordBatch(store: FlightStore, result: IngestResult, dataClockMs: number): Promise<void> {
    if (store !== this.store) return;
    await Promise.resolve(this.options.onIngested?.(store)).catch(() => undefined);
    if (store !== this.store) return;
    this.lastBatch = { received: result.received, inserted: result.inserted, expired: result.expired, dataClockMs: Math.floor(dataClockMs) };
    this.ingestError = null;
    this.emit();
  }

  private async ingest(store: FlightStore, batch: FlightBatch): Promise<void> {
    try {
      const result = await store.ingest(batch);
      if (store !== this.store) return;
      await Promise.resolve(this.options.onIngested?.(store)).catch(() => undefined);
      if (store !== this.store) return;
      this.lastBatch = { received: result.received, inserted: result.inserted, expired: result.expired, dataClockMs: Math.floor(batch.dataClockMs) };
      this.ingestError = null;
    } catch (error) {
      if (store !== this.store) return;
      this.ingestError = errorMessage(error);
    }
    this.emit();
  }

  private async halt(): Promise<void> {
    const running = this.running;
    if (!running) return;
    this.running = null;
    running.source.stop();
    if (running.source instanceof AdsbLolSource) this.lastLivePollAt = running.source.lastPollStartedAt ?? this.lastLivePollAt;
    this.lastFeed = running.source.state();
    await running.reader?.close().catch(() => undefined);
  }

  private async resetStore(): Promise<void> {
    const store = this.store;
    this.store = null;
    this.storeConfig = null;
    this.lastBatch = null;
    if (store) await Promise.resolve(this.options.onStoreClosing?.(store)).catch(() => undefined);
    await store?.close().catch(() => undefined);
  }

  private applyVisibility(): void {
    const source = this.running?.source;
    if (!source) return;
    if (this.paused) source.pause();
    else source.resume();
  }

  private emit(): void {
    this.options.onState?.(this.state());
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      if (this.closed) throw new EngineFailure('engine_unavailable', 'The engine is shutting down');
      return task();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function retentionOf(config: LiveSourceConfig): number | null {
  // An archive keeps its whole fixture: the time cursor moves through all of it.
  if (config.kind === 'archive') return null;
  return config.retentionMs === undefined ? DEFAULT_LIVE_RETENTION_MS : config.retentionMs;
}

function sameConfig(a: LiveSourceConfig, b: LiveSourceConfig): boolean {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

function normalize(config: LiveSourceConfig): unknown[] {
  if (config.kind === 'archive') return ['archive', config.fixture];
  return config.kind === 'live'
    ? ['live', config.intervalMs ?? null, retentionOf(config)]
    : ['replay', config.fixture, config.intervalMs ?? null, config.speed ?? 1, retentionOf(config)];
}

/** A source that never started: stopped with `error` after one failed attempt. */
function stoppedFeed(config: LiveSourceConfig, error: string): LiveSourceState {
  return { kind: config.kind, status: 'stopped', paused: false, attribution: null, license: null, lastSuccessAt: null, dataClockMs: null, nextAttemptAt: null, failures: 1, error, ended: false };
}

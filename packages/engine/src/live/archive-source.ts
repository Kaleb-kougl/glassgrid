import { ADSBLOL_ATTRIBUTION, ADSBLOL_LICENSE, type LiveClock, type LiveSource, type LiveSourceState } from '@glassgrid/core';
import { EngineFailure, errorMessage } from '../errors';
import { systemClock } from './clock';

/*
 * A whole fixture loaded at once (milestone L4, docs/live-flights-l4.md):
 * the `archive` source. It runs one load (the feed's `loadParquet` into an
 * empty store without retention, or one batch of every fix for a fixture
 * held in memory) and then has nothing more to do: the app's time cursor
 * moves through the loaded day ("as of T"), so a seek is a re-query, never a
 * re-ingest. That supersedes L2's tick-by-tick replay for the UI; the
 * replay source stays for agents and for the replay gate.
 *
 * States: `connecting` while loading, `live` once loaded (`dataClockMs`:
 * the last fix), `backoff` after a failed load that may succeed later (a
 * network error: retried after RETRY_ARCHIVE_MS while started), `stopped`
 * with `error` after one that cannot (out of memory, a missing file, no
 * Parquet: retrying would fail the same way, forever, as it did before the
 * L4 review), `stopped` after `stop()`. Pausing (the
 * page is hidden) is only reported: a load in flight finishes, and a
 * scheduled retry waits for the page to be shown.
 */

/** Wait before retrying a failed load. */
export const RETRY_ARCHIVE_MS = 10_000;

/** A load failure that a retry would only repeat: out of memory, a missing fixture, no Parquet here. */
export function isPermanentLoadFailure(error: unknown): boolean {
  if (error instanceof EngineFailure && (error.code === 'out_of_memory' || error.code === 'not_implemented' || error.code === 'engine_unavailable')) return true;
  return /out of memory|\b404\b|not found|no such file|does not exist/i.test(errorMessage(error));
}

export interface ArchiveSourceOptions {
  /** Loads the fixture; resolves with its last fix time (epoch ms), or null when it is empty. */
  load: () => Promise<number | null>;
  onState?: (state: LiveSourceState) => void;
  clock?: LiveClock;
  attribution?: string;
  license?: string;
}

export class ArchiveSource implements LiveSource {
  readonly kind = 'archive';
  private readonly clock: LiveClock;
  private current: LiveSourceState;
  private running = false;
  private paused = false;
  private loaded = false;
  private loading = false;
  private timer: unknown = null;
  /** Bumped by stop(), so a load in flight reports nothing after it. */
  private generation = 0;

  constructor(private readonly options: ArchiveSourceOptions) {
    this.clock = options.clock ?? systemClock;
    this.current = {
      kind: 'archive',
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

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.loaded) {
      this.update({ status: 'live' });
      return;
    }
    this.update({ status: 'connecting', error: null });
    void this.run(this.generation);
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
    if (this.running && !this.loaded && !this.loading) this.retry(RETRY_ARCHIVE_MS);
  }

  private async run(generation: number): Promise<void> {
    if (!this.running || generation !== this.generation || this.loading) return;
    this.loading = true;
    try {
      const lastTs = await this.options.load();
      if (generation !== this.generation) return;
      this.loaded = true;
      this.update({
        status: 'live',
        lastSuccessAt: this.clock.now(),
        dataClockMs: lastTs === null ? null : Math.max(0, Math.floor(lastTs)),
        failures: 0,
        error: null,
        nextAttemptAt: null,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      if (isPermanentLoadFailure(error)) {
        this.running = false;
        this.update({ status: 'stopped', failures: this.current.failures + 1, error: errorMessage(error), nextAttemptAt: null });
        return;
      }
      this.update({ status: 'backoff', failures: this.current.failures + 1, error: errorMessage(error) });
      if (!this.paused) this.retry(RETRY_ARCHIVE_MS);
    } finally {
      this.loading = false;
    }
  }

  private retry(delayMs: number): void {
    this.cancelTimer();
    const generation = this.generation;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.run(generation);
    }, delayMs);
    this.update({ nextAttemptAt: this.clock.now() + delayMs });
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private update(patch: Partial<LiveSourceState>): void {
    this.current = { ...this.current, ...patch };
    this.options.onState?.(this.current);
  }
}

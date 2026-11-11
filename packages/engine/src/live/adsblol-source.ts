import {
  BAY_AREA_BBOX,
  DEFAULT_LIVE_INTERVAL_MS,
  FlightsApiResponseSchema,
  LIVE_STALE_AFTER_MS,
  LIVE_STALE_MARGIN_MS,
  MAX_LIVE_CLOCK_AHEAD_MS,
  MAX_LIVE_INTERVAL_MS,
  MIN_LIVE_INTERVAL_MS,
  fromReadsbAircraft,
  inBbox,
  type FlightBatchSink,
  type FlightBbox,
  type FlightPoint,
  type LiveClock,
  type LiveSource,
  type LiveSourceState,
} from '@glassgrid/core';
import { errorMessage } from '../errors';
import { systemClock } from './clock';

/*
 * The live source: polls the site's relay of adsb.lol (`GET /api/flights`,
 * `FlightsApiResponseSchema`) and emits each response's aircraft as
 * FlightPoints (docs/live-flights-l2.md, "Live").
 *
 * - **URL.** A configuration value: the web demo passes
 *   `liveFlightsUrl(location.origin)` (the site's origin, not the app's
 *   `/glassgrid/` base). Vite's dev server has no such route; there the
 *   source simply backs off on its 404s.
 * - **Cadence.** One request every `intervalMs` (default 20 s, at least
 *   10 s: the CDN caches for 10 s, so faster polls return the same body and
 *   only cost requests), measured from the start of the previous poll.
 *   Requests use `cache: 'no-store'`: the browser must not answer from its
 *   own cache, the CDN's `s-maxage` already bounds the upstream rate.
 * - **Failures.** A 503 (the relay has no data) waits for its `Retry-After`
 *   (seconds or an HTTP date; never less than 10 s). Any other failure
 *   (network error, timeout, other status, a body that is not the
 *   contract) backs off exponentially from the interval with jitter, up to
 *   5 minutes. Neither stops the source.
 * - **Status.** `connecting` until the first answer; `live` after a good
 *   one; `stale` when the body says `stale: true` or nothing succeeded for
 *   `LIVE_STALE_AFTER_MS`; `backoff` while waiting after a failure;
 *   `stopped`. `pause()` (the page is hidden) cancels the request in flight
 *   and the timer; `resume()` polls again once the interval since the last
 *   poll has passed, so hiding and showing a tab never polls faster than
 *   the interval.
 * - **Mapping.** `fromReadsbAircraft(ac, now / 1000, 'live')`: the
 *   contract's `now` is epoch milliseconds and the adapter takes seconds.
 *   Aircraft outside `bbox` (the relay already filters to the Bay Area box)
 *   or without a usable position are skipped.
 */

/** The part of `fetch` the source uses (injected in tests and by the worker). */
export type LiveFetch = (url: string, init: { cache: 'no-store'; headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

/**
 * Longer than the relay's own 15 s upstream timeout (the portfolio's
 * src/lib/flights/upstream-fetch.ts), so a cold relay that is still waiting
 * on adsb.lol's slow TLS handshake (~9 s, measured 2026-11-11) answers before
 * this gives up. A warm relay or a CDN hit answers in well under a second.
 */
export const DEFAULT_LIVE_TIMEOUT_MS = 20_000;
export const MAX_LIVE_BACKOFF_MS = 5 * 60_000;

/**
 * `Retry-After` in ms: delta seconds or an HTTP date (relative to `nowMs`).
 * Null when absent or unreadable.
 */
export function retryAfterMs(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

/**
 * Delay after `failures` consecutive failures: exponential from the
 * interval (interval, 2x, 4x, ...) capped at MAX_LIVE_BACKOFF_MS, with
 * "equal jitter" (half fixed, half random) so many viewers that failed
 * together do not retry together; never below MIN_LIVE_INTERVAL_MS.
 */
export function backoffDelayMs(failures: number, intervalMs: number, random: () => number): number {
  const ceiling = Math.min(MAX_LIVE_BACKOFF_MS, intervalMs * 2 ** Math.max(0, failures - 1));
  return Math.max(MIN_LIVE_INTERVAL_MS, Math.round(ceiling / 2 + random() * (ceiling / 2)));
}

export interface AdsbLolSourceOptions {
  /** The endpoint, e.g. `https://site.example/api/flights`. */
  url: string;
  sink: FlightBatchSink;
  onState?: (state: LiveSourceState) => void;
  fetch?: LiveFetch;
  clock?: LiveClock;
  /** In [0, 1): the backoff jitter (default Math.random). */
  random?: () => number;
  /** Default DEFAULT_LIVE_INTERVAL_MS (20 s); clamped to [MIN_LIVE_INTERVAL_MS, MAX_LIVE_INTERVAL_MS]. */
  intervalMs?: number;
  /** Per-request timeout (default 8 s). */
  timeoutMs?: number;
  /** No success for this long reports `stale` (default: the larger of LIVE_STALE_AFTER_MS and interval + timeout + LIVE_STALE_MARGIN_MS). */
  staleAfterMs?: number;
  /**
   * When the previous poll of this endpoint started, by any source (the
   * feed keeps it across restarts and reconfigurations). The first poll
   * waits until MIN_LIVE_INTERVAL_MS after it, so no sequence of start,
   * stop and setSource calls polls more often than the CDN window.
   */
  lastPollAt?: number | null;
  /** Fixes outside are dropped (default BAY_AREA_BBOX). */
  bbox?: FlightBbox;
}

type PollOutcome =
  | { ok: true; points: FlightPoint[]; nowMs: number; stale: boolean; attribution: string; license: string }
  | { ok: false; error: string; retryAfterMs: number | null };

export class AdsbLolSource implements LiveSource {
  readonly kind = 'live';
  readonly intervalMs: number;
  private readonly fetchImpl: LiveFetch;
  private readonly clock: LiveClock;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly staleAfterMs: number;
  private readonly bbox: FlightBbox;
  private current: LiveSourceState;
  private running = false;
  private paused = false;
  private pollTimer: unknown = null;
  private staleTimer: unknown = null;
  private inflight: AbortController | null = null;
  /** Wall time the last poll started (the cadence counts from it). */
  private lastPollAt: number | null = null;
  /** Bumped by stop() and pause() so a poll in flight never schedules another. */
  private generation = 0;

  constructor(private readonly options: AdsbLolSourceOptions) {
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
    this.intervalMs = Math.min(MAX_LIVE_INTERVAL_MS, Math.max(MIN_LIVE_INTERVAL_MS, options.intervalMs ?? DEFAULT_LIVE_INTERVAL_MS));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_LIVE_TIMEOUT_MS;
    this.staleAfterMs = options.staleAfterMs ?? Math.max(LIVE_STALE_AFTER_MS, this.intervalMs + this.timeoutMs + LIVE_STALE_MARGIN_MS);
    this.lastPollAt = options.lastPollAt ?? null;
    this.bbox = options.bbox ?? BAY_AREA_BBOX;
    this.current = {
      kind: 'live',
      status: 'stopped',
      paused: false,
      attribution: null,
      license: null,
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

  /** When the last poll started (wall clock), or null before the first. */
  get lastPollStartedAt(): number | null {
    return this.lastPollAt;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.update({ status: 'connecting', error: null, failures: 0 });
    if (!this.paused) this.scheduleAt(this.earliestPoll());
  }

  /** Now, or MIN_LIVE_INTERVAL_MS after the previous poll started, whichever is later. */
  private earliestPoll(): number {
    const now = this.clock.now();
    return this.lastPollAt === null ? now : Math.max(now, this.lastPollAt + MIN_LIVE_INTERVAL_MS);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.halt();
    this.update({ status: 'stopped', nextAttemptAt: null });
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.halt();
    this.update({ paused: true, nextAttemptAt: null });
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.update({ paused: false });
    if (!this.running) return;
    const now = this.clock.now();
    // Never sooner than one interval after the last poll (hide/show must not add requests).
    this.scheduleAt(this.lastPollAt === null ? now : Math.max(now, this.lastPollAt + this.intervalMs));
    this.armStaleTimer();
  }

  /** Cancel the timers and the request in flight; a poll that is mid-way drops its result. */
  private halt(): void {
    this.generation += 1;
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    if (this.staleTimer !== null) this.clock.clearTimeout(this.staleTimer);
    this.pollTimer = null;
    this.staleTimer = null;
    this.inflight?.abort();
    this.inflight = null;
  }

  /** Schedule the next poll; `patch` is reported in the same state change. */
  private scheduleAt(atMs: number, patch: Partial<LiveSourceState> = {}): void {
    if (this.pollTimer !== null) this.clock.clearTimeout(this.pollTimer);
    const generation = this.generation;
    const delay = Math.max(0, atMs - this.clock.now());
    this.pollTimer = this.clock.setTimeout(() => {
      this.pollTimer = null;
      void this.poll(generation);
    }, delay);
    this.update({ ...patch, nextAttemptAt: this.clock.now() + delay });
  }

  /** `stale` once nothing has succeeded for staleAfterMs (re-armed by every success). */
  private armStaleTimer(): void {
    if (this.staleTimer !== null) this.clock.clearTimeout(this.staleTimer);
    this.staleTimer = null;
    const last = this.current.lastSuccessAt;
    if (!this.running || this.paused || last === null) return;
    const generation = this.generation;
    const check = () => {
      this.staleTimer = null;
      if (generation !== this.generation || !this.running || this.paused) return;
      const since = this.current.lastSuccessAt;
      if (since === null) return;
      const left = since + this.staleAfterMs - this.clock.now();
      if (left > 0) {
        this.staleTimer = this.clock.setTimeout(check, left + 1);
        return;
      }
      // A failure in progress keeps its `backoff`; `live` turns `stale`.
      if (this.current.status === 'live') this.update({ status: 'stale' });
    };
    this.staleTimer = this.clock.setTimeout(check, Math.max(0, last + this.staleAfterMs - this.clock.now() + 1));
  }

  private async poll(generation: number): Promise<void> {
    if (generation !== this.generation || !this.running || this.paused) return;
    const startedAt = this.clock.now();
    this.lastPollAt = startedAt;
    const outcome = await this.fetchOnce();
    if (generation !== this.generation) return;

    if (outcome.ok) {
      await this.options.sink({ points: outcome.points, dataClockMs: outcome.nowMs }).catch(() => undefined);
      if (generation !== this.generation) return;
      this.scheduleAt(startedAt + this.intervalMs, {
        status: outcome.stale ? 'stale' : 'live',
        attribution: outcome.attribution,
        license: outcome.license,
        lastSuccessAt: this.clock.now(),
        dataClockMs: outcome.nowMs,
        failures: 0,
        error: null,
      });
      this.armStaleTimer();
      return;
    }

    const failures = this.current.failures + 1;
    const delay =
      outcome.retryAfterMs !== null
        ? Math.min(MAX_LIVE_BACKOFF_MS, Math.max(MIN_LIVE_INTERVAL_MS, outcome.retryAfterMs))
        : backoffDelayMs(failures, this.intervalMs, this.random);
    this.scheduleAt(this.clock.now() + delay, { status: 'backoff', failures, error: outcome.error });
  }

  private async fetchOnce(): Promise<PollOutcome> {
    const controller = new AbortController();
    this.inflight = controller;
    const timeout = { fired: false };
    const timer = this.clock.setTimeout(() => {
      timeout.fired = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.options.url, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        const retry = response.status === 503 || response.status === 429 ? retryAfterMs(response.headers.get('retry-after'), this.clock.now()) : null;
        await response.body?.cancel().catch(() => undefined);
        const what = response.status === 503 ? 'no data (HTTP 503)' : `HTTP ${response.status}`;
        return { ok: false, error: `${this.options.url}: ${what}`, retryAfterMs: retry };
      }
      const parsed = FlightsApiResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return { ok: false, error: `Unexpected response: ${issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid'}`, retryAfterMs: null };
      }
      const body = parsed.data;
      const nowSec = body.now / 1000;
      const points: FlightPoint[] = [];
      for (const aircraft of body.ac) {
        const point = fromReadsbAircraft(aircraft, nowSec, 'live');
        if (point !== null && inBbox(point.lat, point.lon, this.bbox)) points.push(point);
      }
      // Retention counts back from this clock: never let a relay clock far ahead of ours expire everything.
      const nowMs = Math.min(body.now, this.clock.now() + MAX_LIVE_CLOCK_AHEAD_MS);
      return { ok: true, points, nowMs, stale: body.stale, attribution: body.attribution, license: body.license };
    } catch (error) {
      return { ok: false, error: timeout.fired ? `${this.options.url}: no answer within ${this.timeoutMs} ms` : errorMessage(error), retryAfterMs: null };
    } finally {
      this.clock.clearTimeout(timer);
      if (this.inflight === controller) this.inflight = null;
    }
  }

  private update(patch: Partial<LiveSourceState>): void {
    this.current = { ...this.current, ...patch };
    this.options.onState?.(this.current);
  }
}

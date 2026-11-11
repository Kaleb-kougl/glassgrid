/**
 * Polling adsb.lol's live API for the aircraft around a box, for
 * `record-flights`. Network access is injected (`fetch`, `sleep`, `now`), so
 * the loop runs under fake timers in tests.
 */
import {
  bboxCenter,
  bboxCoverRadiusNm,
  fromReadsbAircraft,
  inBbox,
  parseReadsbResponse,
  type FlightBbox,
  type FlightPoint,
} from '@glassgrid/core';

// ---------------------------------------------------------------------------
// The endpoint. UNVERIFIED: written from adsb.lol's README ("a drop-in
// replacement for the ADSBExchange v2 API") and readsb's `&jv2` output
// format, not checked against the Swagger page at https://api.adsb.lol/docs,
// which the build environment cannot reach. Check the path, the radius limit
// and the units of `now` there (and with `record-flights --raw`) before
// relying on it; this is the only place that knows the URL.

export const ADSBLOL_API_BASE = 'https://api.adsb.lol';

/** adsb.lol documents a 250 nm cap on point queries (unverified, see above). */
export const ADSBLOL_MAX_RADIUS_NM = 250;

/** `GET {base}/v2/point/{lat}/{lon}/{radius_nm}`: every aircraft within the radius (unverified, see above). */
export function adsbLolPointUrl(lat: number, lon: number, radiusNm: number, base: string = ADSBLOL_API_BASE): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radiusNm) || radiusNm <= 0) {
    throw new Error(`invalid point query ${lat}, ${lon}, ${radiusNm} nm`);
  }
  const radius = Math.min(ADSBLOL_MAX_RADIUS_NM, Math.ceil(radiusNm));
  const fixed = (n: number) => String(Math.round(n * 1e4) / 1e4);
  return `${base.replace(/\/+$/, '')}/v2/point/${fixed(lat)}/${fixed(lon)}/${radius}`;
}

/** The point query around a box's centre that covers the whole box. */
export function adsbLolBboxUrl(bbox: FlightBbox, base: string = ADSBLOL_API_BASE): string {
  const { lat, lon } = bboxCenter(bbox);
  return adsbLolPointUrl(lat, lon, bboxCoverRadiusNm(bbox), base);
}

// ---------------------------------------------------------------------------

export type LiveFetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export interface RecordOptions {
  url: string;
  bbox: FlightBbox;
  /** How long to record. */
  durationMs: number;
  /** Poll cadence (default 10 s). Polls are scheduled on this grid from the start, not after each response. */
  intervalMs?: number;
  /** Per-request timeout (default 8 s). */
  timeoutMs?: number;
  fetch?: LiveFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Each successful poll's raw JSON (for `--raw`). */
  onResponse?: (json: unknown, atMs: number) => void;
  log?: (message: string) => void;
}

export interface PollError {
  atMs: number;
  status: number | null;
  message: string;
}

export interface RecordResult {
  /** Unique (hex, ts) fixes inside the box, in arrival order. */
  points: FlightPoint[];
  polls: number;
  okPolls: number;
  errors: PollError[];
  /** Aircraft objects in the responses that had no usable position or were outside the box. */
  skipped: number;
  startedAtMs: number;
  endedAtMs: number;
}

/** Statuses worth retrying: rate limited, or a server/gateway failure. */
export function isRetryable(status: number): boolean {
  return status === 429 || status === 408 || status >= 500;
}

/**
 * Backoff before the next attempt after `failures` consecutive failures:
 * the server's `Retry-After` (seconds) when it sent one, else 2 s, 4 s, 8 s,
 * ... capped at 60 s.
 */
export function backoffMs(failures: number, retryAfter: string | null): number {
  const seconds = retryAfter !== null && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter.trim()) : null;
  if (seconds !== null) return Math.min(300_000, seconds * 1000);
  return Math.min(60_000, 1000 * 2 ** Math.max(1, failures));
}

/** An HTTP error retrying cannot fix (a wrong URL or a removed endpoint). */
export class EndpointError extends Error {
  override name = 'EndpointError';
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls `url` every `intervalMs` until `durationMs` has passed, mapping each
 * response with `fromReadsbAircraft` (source `live`), keeping fixes inside
 * `bbox` and dropping repeats of a (hex, ts) already seen (an aircraft
 * without a new position since the last poll). A 429, 408 or 5xx response,
 * a timeout or a network error backs off (see `backoffMs`) and carries on;
 * any other HTTP error (a wrong URL) stops the recording with an error.
 */
export async function recordLive(options: RecordOptions): Promise<RecordResult> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 8_000;
  const log = options.log ?? (() => undefined);

  const startedAtMs = now();
  const endAtMs = startedAtMs + options.durationMs;
  const seen = new Set<string>();
  const points: FlightPoint[] = [];
  const errors: PollError[] = [];
  let polls = 0;
  let okPolls = 0;
  let skipped = 0;
  let failures = 0;
  let nextAtMs = startedAtMs;

  while (nextAtMs < endAtMs) {
    const wait = nextAtMs - now();
    if (wait > 0) await sleep(wait);
    const atMs = now();
    polls += 1;
    let retryAfter: string | null = null;
    let failed: PollError | null = null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(options.url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      if (!res.ok) {
        retryAfter = res.headers.get('retry-after');
        try {
          await res.body?.cancel();
        } catch {
          // ignore
        }
        if (!isRetryable(res.status)) throw new EndpointError(`GET ${options.url}: HTTP ${res.status} (not retrying; check the endpoint in src/lib/adsblol.ts)`);
        failed = { atMs, status: res.status, message: `HTTP ${res.status}` };
      } else {
        const json: unknown = await res.json();
        const parsed = parseReadsbResponse(json);
        if (parsed === null) {
          failed = { atMs, status: res.status, message: 'response has no now/ac fields' };
        } else {
          okPolls += 1;
          failures = 0;
          options.onResponse?.(json, atMs);
          let fresh = 0;
          for (const ac of parsed.aircraft) {
            const fix = fromReadsbAircraft(ac, parsed.nowSec, 'live');
            if (fix === null || !inBbox(fix.lat, fix.lon, options.bbox)) {
              skipped += 1;
              continue;
            }
            const key = `${fix.hex}|${fix.ts}`;
            if (seen.has(key)) continue;
            seen.add(key);
            points.push(fix);
            fresh += 1;
          }
          log(`poll ${polls}: ${parsed.aircraft.length} aircraft, ${fresh} new fixes in the box (${points.length} total)`);
        }
      }
    } catch (err) {
      if (err instanceof EndpointError) throw err;
      const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : '';
      failed = { atMs, status: null, message: `${err instanceof Error ? err.message : String(err)}${cause}` };
    } finally {
      clearTimeout(timer);
    }

    if (failed) {
      errors.push(failed);
      failures += 1;
      const delay = backoffMs(failures, retryAfter);
      log(`poll ${polls} failed (${failed.message}); backing off ${Math.round(delay / 1000)} s`);
      // Resume on the cadence grid at or after the backoff.
      const resumeAt = now() + delay;
      nextAtMs = startedAtMs + Math.ceil((resumeAt - startedAtMs) / intervalMs) * intervalMs;
    } else {
      nextAtMs += intervalMs;
      // A slow response: skip the ticks already missed instead of polling back to back.
      const t = now();
      if (nextAtMs <= t) nextAtMs = startedAtMs + Math.ceil((t - startedAtMs) / intervalMs) * intervalMs;
    }
  }
  return { points, polls, okPolls, errors, skipped, startedAtMs, endedAtMs: now() };
}

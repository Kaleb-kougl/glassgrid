import { describe, expect, it } from 'vitest';
import type { LiveSourceState } from '@glassgrid/core';
import { FALLBACK_AFTER_FAILURES, FALLBACK_LONG_WAIT_MS, FALLBACK_STALE_MS, fallbackAnnouncement, fallbackReason } from './live-fallback';

/* When the recorded traffic is offered in place of the live feed (L5, live-fallback.ts). */

const NOW = Date.parse('2026-11-11T20:00:00.000Z');

function feed(patch: Partial<LiveSourceState>): LiveSourceState {
  return { kind: 'live', status: 'live', paused: false, attribution: null, license: null, lastSuccessAt: null, dataClockMs: null, nextAttemptAt: null, failures: 0, error: null, ended: false, ...patch };
}

describe('fallbackReason', () => {
  it('never for a healthy, connecting or stopped feed, a replay or an archive', () => {
    expect(fallbackReason(null, true, NOW)).toBeNull();
    expect(fallbackReason(feed({}), true, NOW)).toBeNull();
    expect(fallbackReason(feed({ status: 'stopped' }), false, NOW)).toBeNull();
    expect(fallbackReason(feed({ kind: 'archive', status: 'backoff', failures: 9 }), false, NOW)).toBeNull();
    expect(fallbackReason(feed({ kind: 'replay', status: 'backoff', failures: 9 }), true, NOW)).toBeNull();
  });

  it('offline: at once, whatever the feed has tried (its last poll may even have succeeded)', () => {
    expect(fallbackReason(feed({ status: 'live' }), false, NOW)).toBe('offline');
    expect(fallbackReason(feed({ status: 'connecting' }), false, NOW)).toBe('offline');
    expect(fallbackReason(feed({ status: 'backoff', failures: 1 }), false, NOW)).toBe('offline');
  });

  it('failing: after three failures in a row', () => {
    expect(FALLBACK_AFTER_FAILURES).toBe(3);
    expect(fallbackReason(feed({ status: 'backoff', failures: 2 }), true, NOW)).toBeNull();
    expect(fallbackReason(feed({ status: 'backoff', failures: 3 }), true, NOW)).toBe('failing');
  });

  it('rate-limited: at once for a wait of a minute or more (the delay the feed reports), else after three failures', () => {
    expect(fallbackReason(feed({ status: 'rate-limited', failures: 1, nextAttemptAt: NOW + FALLBACK_LONG_WAIT_MS - 1, retryDelayMs: FALLBACK_LONG_WAIT_MS - 1 }), true, NOW)).toBeNull();
    expect(fallbackReason(feed({ status: 'rate-limited', failures: 1, nextAttemptAt: NOW + FALLBACK_LONG_WAIT_MS, retryDelayMs: FALLBACK_LONG_WAIT_MS }), true, NOW)).toBe('rate-limited');
    expect(fallbackReason(feed({ status: 'rate-limited', failures: 3, nextAttemptAt: NOW + 10_000, retryDelayMs: 10_000 }), true, NOW)).toBe('rate-limited');
  });

  it('rate-limited: a reader whose clock lags far behind does not mistake a 30 s Retry-After for a long one', () => {
    const stale = NOW - 5 * 60_000;
    expect(fallbackReason(feed({ status: 'rate-limited', failures: 1, nextAttemptAt: NOW + 30_000, retryDelayMs: 30_000 }), true, stale)).toBeNull();
  });

  it('announces one sentence per reason, without the failure count', () => {
    expect(fallbackAnnouncement('failing')).toBe('The live feed is not answering. Recorded traffic is available instead.');
    expect(fallbackAnnouncement('offline')).toBe('You are offline, so the live feed cannot be reached. Recorded traffic is available instead.');
  });

  it('stale: once the relay’s snapshot is two minutes old', () => {
    expect(fallbackReason(feed({ status: 'stale', dataClockMs: NOW - FALLBACK_STALE_MS + 1 }), true, NOW)).toBeNull();
    expect(fallbackReason(feed({ status: 'stale', dataClockMs: NOW - FALLBACK_STALE_MS }), true, NOW)).toBe('stale');
  });
});

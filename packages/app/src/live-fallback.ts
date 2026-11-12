import { useEffect, useRef, useState } from 'react';
import { MIN_LIVE_INTERVAL_MS, type LiveSourceState } from '@glassgrid/core';
import type { PlatformLive, PlatformWindow } from './platform';

/*
 * Offline → replay (milestone L5, docs/live-flights.md): when the live feed
 * cannot deliver, the map card offers the recorded 30 minutes instead, one
 * click, never on its own. The choice is remembered for the tab (the
 * platform's session storage), and while the recorded traffic shows, the
 * live relay is probed now and then so the card can say "Back to live" once
 * it answers again.
 *
 * When the offer appears (`fallbackReason`), and why:
 *
 * - **Offline** (`navigator.onLine` false): at once. The browser already
 *   knows no poll can succeed, and waiting for three failed polls would only
 *   show an empty map for another minute.
 * - **Failing**: three failures in a row (`FALLBACK_AFTER_FAILURES`). How
 *   long that takes depends on how the polls fail, from the first failing
 *   poll (which itself comes up to one 20 s interval after the last good
 *   one), with the engine's constants (adsblol-source.ts: a 20 s request
 *   timeout, backoff of half to all of 20 s × 2^(n−1), never under 10 s):
 *   - the relay's 503 with `Retry-After: 10` (it has no snapshot): the
 *     retries come 10 s apart, so the third failure is **20 s** after the
 *     first;
 *   - fast errors without Retry-After (network down, a 404): 10–20 s, then
 *     20–40 s: **30–60 s**;
 *   - no answer at all (each poll waits out its 20 s timeout): 20 s + 10–20 s
 *     + 20 s + 20–40 s + 20 s: **90–120 s**.
 *
 *   Long enough that one dropped poll or a cold relay's slow TLS handshake to
 *   adsb.lol (9 to 45 s, measured; the relay answers it within the client's
 *   timeout) does not trigger it.
 * - **Rate-limited**: at once when the server asks to wait a minute or more
 *   (`FALLBACK_LONG_WAIT_MS`, judged by the delay the feed reports,
 *   `retryDelayMs`, not by a clock), else after three failures like any other.
 * - **Stale**: when the relay has served the same old snapshot for two
 *   minutes (`FALLBACK_STALE_MS`): the aircraft are frozen in place.
 *
 * Once offered, the offer stays (it is latched) until the feed succeeds
 * again (online), so a countdown that drops below a minute does not take it
 * away. "Keep trying" dismisses the current reason only: a more severe one
 * (failing < rate-limited < offline; stale is the mildest) offers it again,
 * and so does a new failure after the feed has recovered.
 */

/** Consecutive failed polls before the recorded traffic is offered. */
export const FALLBACK_AFTER_FAILURES = 3;
/** A Retry-After this long or longer offers the recorded traffic at once. */
export const FALLBACK_LONG_WAIT_MS = 60_000;
/** Stale data this old (by the relay's own clock) offers the recorded traffic. */
export const FALLBACK_STALE_MS = 2 * 60_000;
/** While the recorded traffic shows, the relay is probed this often (and at once when the browser comes back online). */
export const LIVE_PROBE_INTERVAL_MS = 60_000;

export type FallbackReason = 'offline' | 'failing' | 'rate-limited' | 'stale';

/** Why the recorded traffic should be offered now, or null. Only for the live source (not a replay or an archive). */
export function fallbackReason(feed: LiveSourceState | null, online: boolean, nowMs: number): FallbackReason | null {
  if (feed === null || feed.kind !== 'live' || feed.status === 'stopped') return null;
  if (!online) return 'offline';
  if (feed.status === 'live') return null;
  if (feed.status === 'rate-limited') {
    // The delay the source chose (Retry-After), not `nextAttemptAt − now`: a reader's clock may lag behind.
    const wait = feed.retryDelayMs ?? 0;
    return feed.failures >= FALLBACK_AFTER_FAILURES || wait >= FALLBACK_LONG_WAIT_MS ? 'rate-limited' : null;
  }
  if (feed.status === 'backoff') return feed.failures >= FALLBACK_AFTER_FAILURES ? 'failing' : null;
  // A lagging clock only underestimates the snapshot's age here, so it can delay the offer, never bring it early.
  if (feed.status === 'stale') return feed.dataClockMs !== null && nowMs - feed.dataClockMs >= FALLBACK_STALE_MS ? 'stale' : null;
  return null;
}

/** How serious a reason is, for "Keep trying": only a more serious one offers the recording again. */
const SEVERITY: Record<FallbackReason, number> = { stale: 1, failing: 2, 'rate-limited': 3, offline: 4 };

/** The offer's sentence, by reason (shown; the failing count goes up with every failure). */
export function fallbackMessage(reason: FallbackReason, failures: number): string {
  switch (reason) {
    case 'offline':
      return 'You are offline, so the live feed cannot be reached.';
    case 'failing':
      return `The live feed has not answered ${failures} times in a row.`;
    case 'rate-limited':
      return 'The live feed is rate-limited for now.';
    case 'stale':
      return 'The live feed has had no new data for over two minutes.';
  }
}

/** What the offer's polite region says: one sentence per reason, with no count, so a new failure is not announced again. */
export function fallbackAnnouncement(reason: FallbackReason): string {
  const cause = reason === 'failing' ? 'The live feed is not answering.' : fallbackMessage(reason, 0);
  return `${cause} Recorded traffic is available instead.`;
}

/**
 * The offer, latched: a reason once one arises for the running live feed, until it succeeds again (status
 * `live`) or stops being the live source. `dismiss()` ("Keep trying") hides it for the current reason and any milder
 * one, until the feed has recovered once.
 */
export function useFallbackOffer(feed: LiveSourceState | null, online: boolean, nowMs: number): { reason: FallbackReason | null; dismiss: () => void } {
  const [latched, setLatched] = useState<FallbackReason | null>(null);
  const [dismissed, setDismissed] = useState<FallbackReason | null>(null);
  const recovered = feed === null || feed.kind !== 'live' || feed.status === 'stopped' || (feed.status === 'live' && online);
  const reason = fallbackReason(feed, online, nowMs);
  let next = latched;
  if (recovered) next = null;
  else if (reason !== null) next = reason;
  else if (latched === 'offline' && online) next = null; // back online: only the feed's own reason, if any, offers it
  if (next !== latched) setLatched(next);
  if (recovered && dismissed !== null) setDismissed(null);
  const hidden = next !== null && dismissed !== null && SEVERITY[next] <= SEVERITY[dismissed];
  return { reason: hidden ? null : next, dismiss: () => setDismissed(next) };
}

/** `navigator.onLine`, as the platform reports it (always online without a platform hook). */
export function useOnline(live: PlatformLive | undefined): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => live?.onOnlineChange?.(setOnline), [live]);
  return online;
}

/**
 * While `enabled` (the recorded traffic shows in place of a live feed the person asked for): probes the live relay
 * once per LIVE_PROBE_INTERVAL_MS while the page is visible and online (the first one interval after the fallback
 * began, since the feed had just failed), and at once when the browser comes back online. Never twice within
 * MIN_LIVE_INTERVAL_MS (the relay's CDN window). Returns whether the last probe found fresh live data; null until one
 * answered. Once one has (true), it stops probing until `enabled` goes false and true again (the person went back to
 * live, or chose the recording anew), so the "Back to live" button cannot come and go. A probe in flight is aborted
 * when the page is hidden, goes offline, or the hook goes away.
 */
export function useLiveProbe(
  live: PlatformLive | undefined,
  enabled: boolean,
  online: boolean,
  shell: Pick<PlatformWindow, 'onVisibilityChange'>,
): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [visible, setVisible] = useState(true);
  /** When the fallback began, and when the relay was last probed: the next scheduled probe counts from the later. */
  const enteredAt = useRef(0);
  const probedAt = useRef(0);
  const wasOnline = useRef(online);
  useEffect(() => shell.onVisibilityChange?.(setVisible), [shell]);
  useEffect(() => {
    if (enabled) enteredAt.current = Date.now();
    else setAvailable(null);
  }, [enabled]);
  const found = available === true;
  useEffect(() => {
    const cameOnline = online && !wasOnline.current;
    wasOnline.current = online;
    if (!enabled || found || live?.probe === undefined || !visible) return;
    if (!online) {
      setAvailable(false);
      return;
    }
    const controller = new AbortController();
    const now = Date.now();
    const floor = probedAt.current + MIN_LIVE_INTERVAL_MS;
    const first = cameOnline ? Math.max(now, floor) : Math.max(floor, Math.max(enteredAt.current, probedAt.current) + LIVE_PROBE_INTERVAL_MS);
    let timer = setTimeout(function tick() {
      probedAt.current = Date.now();
      (live.probe?.(controller.signal) ?? Promise.resolve(false)).then(
        (ok) => {
          if (!controller.signal.aborted) setAvailable(ok);
        },
        () => {
          if (!controller.signal.aborted) setAvailable(false);
        },
      );
      timer = setTimeout(tick, LIVE_PROBE_INTERVAL_MS);
    }, first - now);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [live, enabled, found, online, visible]);
  return enabled ? available : null;
}

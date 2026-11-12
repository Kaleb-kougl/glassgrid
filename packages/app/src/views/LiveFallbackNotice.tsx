import { useEffect, useLayoutEffect, useRef } from 'react';
import type { LiveSourceState } from '@glassgrid/core';
import { Button } from '@glassgrid/ui';
import { shortFeedError } from '../flights';
import { fallbackAnnouncement, fallbackMessage, useFallbackOffer, useLiveProbe } from '../live-fallback';
import type { PlatformLive, PlatformWindow } from '../platform';
import { useNow } from './use-now';

/*
 * The offline → replay strip in the first map card (milestone L5,
 * `live-fallback.ts`): while the live feed cannot deliver, "Watch the
 * recorded traffic instead" (and "Keep trying"); while the recorded traffic
 * shows in its place, what it is (or that it is still loading, or did not
 * load and why), and "Back to live" once a probe of the relay finds fresh
 * data. Nothing switches without a click.
 *
 * - Its polite region is always mounted (a region that appears with its
 *   text is not reliably announced) and says each change once: the offer
 *   (one sentence per reason, no failure count), that the recording did not
 *   load, that live data is back.
 * - A recording that did not load is tried again when the browser comes
 *   back online, and on "Try again".
 * - Its buttons remove themselves; focus then goes to what replaced them
 *   (the strip) or, when the strip is gone, to the map card, never to the
 *   page's body.
 */

export interface LiveFallbackNoticeProps {
  /** `live`: the live feed the person asked for is running; `recorded`: the recorded traffic was chosen in its place. */
  mode: 'live' | 'recorded';
  /** The running source's state: the live feed's (mode `live`) or the recording's (mode `recorded`). */
  feed: LiveSourceState | null;
  online: boolean;
  live: PlatformLive;
  /** Where page visibility comes from (no probes while the page is hidden). */
  shell: Pick<PlatformWindow, 'onVisibilityChange'>;
  onWatchRecorded: () => void;
  /** Load the recording again (it did not load). */
  onRetryRecorded: () => void;
  onBackToLive: () => void;
  testId: string;
}

/** The recording's state, as the strip says it. */
function recordedState(feed: LiveSourceState | null): { state: 'loading' | 'shown' | 'failed'; error: string | null } {
  if (feed === null || feed.kind !== 'archive') return { state: 'loading', error: null };
  if (feed.status === 'live') return { state: 'shown', error: null };
  if (feed.status === 'stopped' || feed.status === 'backoff') return { state: 'failed', error: shortFeedError(feed.error) };
  return { state: 'loading', error: null };
}

export function LiveFallbackNotice({ mode, feed, online, live, shell, onWatchRecorded, onRetryRecorded, onBackToLive, testId }: LiveFallbackNoticeProps) {
  const liveFeed = mode === 'live' ? feed : null;
  // The stale rule reads the wall clock (the snapshot's age): ticking only while the feed is failing.
  const now = useNow(liveFeed !== null && liveFeed.status !== 'live' && liveFeed.status !== 'stopped');
  const offer = useFallbackOffer(liveFeed, online, now);
  const recorded = mode === 'recorded' ? recordedState(feed) : null;
  const available = useLiveProbe(live, recorded?.state === 'shown', online, shell);
  // Without a probe the way back is always offered.
  const canGoBack = live.probe === undefined ? true : available === true;

  // A recording that failed to load (offline, most likely) is tried again once the browser is back online.
  const failed = recorded?.state === 'failed';
  const wasOnline = useRef(online);
  useEffect(() => {
    const cameOnline = online && !wasOnline.current;
    wasOnline.current = online;
    if (cameOnline && failed) onRetryRecorded();
  }, [online, failed, onRetryRecorded]);

  // Focus after a button that removes itself: the strip if it is still there, else the map card.
  const anchor = useRef<HTMLSpanElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  /** The button pressed (and what had focus when it was pressed), until it is gone and focus has moved on. */
  const pendingFocus = useRef<{ id: string; focused: Element | null } | null>(null);
  useLayoutEffect(() => {
    const pressed = pendingFocus.current;
    if (pressed === null) return;
    const button = anchor.current?.parentElement?.querySelector(`[data-testid="${pressed.id}"]`);
    if (button) return; // still there (the switch has not happened yet)
    pendingFocus.current = null;
    // Only when focus was lost with the button, or is still where it was when the button was pressed (Safari, and
    // Firefox on macOS, do not focus a clicked button), not if the person has moved on meanwhile.
    const active = document.activeElement;
    if (active !== null && active !== document.body && active !== pressed.focused) return;
    const target = strip.current ?? anchor.current?.closest<HTMLElement>('.map-card') ?? null;
    target?.focus({ preventScroll: true });
  });
  const press = (id: string, action: () => void) => {
    pendingFocus.current = { id, focused: document.activeElement };
    action();
  };

  let body = null;
  let announce = '';
  if (mode === 'live' && offer.reason !== null) {
    const message = fallbackMessage(offer.reason, liveFeed?.failures ?? 0);
    announce = fallbackAnnouncement(offer.reason);
    body = (
      <>
        <p className="map-card__notice-text">{message} The recorded half hour of Bay Area traffic is ready to play instead.</p>
        <span className="map-card__notice-actions">
          <Button variant="secondary" size="sm" onClick={() => press(`${testId}-watch-recorded`, onWatchRecorded)} data-testid={`${testId}-watch-recorded`}>
            Watch the recorded traffic instead
          </Button>
          <Button variant="ghost" size="sm" onClick={() => press(`${testId}-keep-trying`, offer.dismiss)} data-testid={`${testId}-keep-trying`}>
            Keep trying
          </Button>
        </span>
      </>
    );
  } else if (recorded !== null) {
    let text: string;
    if (recorded.state === 'loading') text = 'Loading the recorded traffic (Nov 9, 2026)…';
    else if (recorded.state === 'failed') {
      text = `The recorded traffic didn’t load${recorded.error ? `: ${recorded.error}` : ''}. ${online ? 'Try again, or go back to live.' : 'It will try again when you are back online.'}`;
      announce = `The recorded traffic didn’t load.${online ? '' : ' It will try again when you are back online.'}`;
    } else {
      const back = canGoBack ? (live.probe === undefined ? '' : ' Live data is available again.') : online ? ' Checking the live feed every minute.' : ' You are offline.';
      text = `Showing recorded traffic (Nov 9, 2026) because the live feed was unavailable.${back}`;
      announce = canGoBack && live.probe !== undefined ? 'Live data is available again.' : '';
    }
    // The way back is always there when the recording is not showing; once it shows, when live data is back.
    const offerBack = recorded.state !== 'shown' || canGoBack;
    body = (
      <>
        <p className="map-card__notice-text">{text}</p>
        <span className="map-card__notice-actions">
          {recorded.state === 'failed' && online && (
            <Button variant="secondary" size="sm" onClick={onRetryRecorded} data-testid={`${testId}-retry-recorded`}>
              Try again
            </Button>
          )}
          {offerBack && (
            <Button variant={recorded.state === 'shown' ? 'secondary' : 'ghost'} size="sm" onClick={() => press(`${testId}-back-to-live`, onBackToLive)} data-testid={`${testId}-back-to-live`}>
              Back to live
            </Button>
          )}
        </span>
      </>
    );
  }
  return (
    <>
      {body !== null && (
        <div
          ref={strip}
          className="map-card__notice"
          role="group"
          aria-label="Live feed"
          tabIndex={-1}
          data-testid={testId}
          data-mode={mode}
          data-reason={offer.reason ?? undefined}
          data-recorded={recorded?.state}
        >
          {body}
        </div>
      )}
      <span ref={anchor} className="gg-visually-hidden" aria-live="polite" aria-atomic="true" data-testid={`${testId}-announce`}>
        {announce}
      </span>
    </>
  );
}

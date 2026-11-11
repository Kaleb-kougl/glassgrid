import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { MAX_REPLAY_SPEED, type TimeCursor, type TimeRange } from '@glassgrid/core';
import { Button } from '@glassgrid/ui';
import { formatLocalTime, formatSpan, formatUtcDate, formatUtcTime, scrubSteps } from '../time-format';

/*
 * The time scrubber (milestone L4, docs/live-flights-l4.md): T, the time the
 * map shows (and, with "Charts follow time", the end of the charts' and the
 * grid's window), over the loaded data's range.
 *
 * - A slider (`role="slider"`): drag it, or with focus the arrow keys step
 *   about 1/200 of the range, Page Up / Page Down about 1/20, Home and End
 *   jump to the ends (scrubSteps). Its value reads as UTC and local time.
 * - Play / Pause advances T at the chosen speed (1× to 120×); dragging
 *   holds it (no dead reckoning while scrubbing) and a drag that started
 *   while playing plays on from where it was let go.
 * - Live data has a Live switch: on, T follows the feed's clock; off, T
 *   stays put while the feed goes on polling and ingesting, and the slider
 *   reaches back over the retained window.
 * - Optional actions: "Load full day" (the 14.5 MB day fixture), and
 *   "Charts follow time".
 *
 * Changes go out through `onSeek` and friends as `setTime` /
 * `setChartsFollowTime` commands (the app), never as local state, so the
 * MCP bridge sees the same cursor. Drags are throttled to one seek per frame.
 */

export const SPEEDS = [1, 2, 5, 10, 30, 60, MAX_REPLAY_SPEED] as const;

export interface TimeScrubberProps {
  /** The data's first and last fix; null while unknown (the slider is disabled). */
  range: TimeRange | null;
  /** T now (resolved from the cursor and the wall clock), or null while unknown. */
  atMs: number | null;
  cursor: TimeCursor;
  /** The table is fed live (a Live switch, and "Live" when following). */
  live: boolean;
  /** T is at the end of an archive or file and the cursor is not moving (Play starts over). */
  atEnd: boolean;
  chartsFollow: boolean;
  /**
   * "Load full day" (shown when given): `offer` the button; `loading` while
   * the day loads; `failed` (its error) offers to retry or go back to the
   * half hour; `loaded` says so in the same place, so nothing moves.
   */
  loadDay?: LoadDay | undefined;
  /** The data's range is being worked out (another source loaded, its profile not back yet): the range says "Loading…". */
  rangePending?: boolean | undefined;
  /**
   * The cursor is held at a time the feed no longer keeps (paused longer
   * than its retention): T shows the oldest fix kept, and the bar says why
   * it moved.
   */
  expired?: boolean | undefined;
  /** Move T: `paused` holds it there, `playing` plays on from it, `keep` keeps the cursor's mode (live becomes paused). */
  onSeek: (atMs: number, mode: 'paused' | 'playing' | 'keep') => void;
  onPlay: () => void;
  onPause: () => void;
  onLive: () => void;
  onSpeed: (speed: number) => void;
  onChartsFollow: (enabled: boolean) => void;
  /** Labels the region (the map's title). */
  label: string;
}

export type LoadDay =
  | { readonly state: 'offer' | 'loading' | 'loaded'; readonly onLoad: () => void }
  | { readonly state: 'failed'; readonly error: string; readonly onLoad: () => void; readonly onBack: () => void };

/** `23:41:05 UTC, 15:41:05 PST` (the slider's value text, and the line under it). */
export function timeValueText(ms: number): string {
  return `${formatUtcTime(ms)} UTC, ${formatLocalTime(ms)}`;
}

export function TimeScrubber({ range, atMs, cursor, live, atEnd, chartsFollow, loadDay, rangePending, expired, onSeek, onPlay, onPause, onLive, onSpeed, onChartsFollow, label }: TimeScrubberProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ resume: boolean; frame: number; pending: number | null } | null>(null);
  useEffect(
    () => () => {
      if (drag.current?.frame) cancelAnimationFrame(drag.current.frame);
    },
    [],
  );
  const span = range === null ? 0 : Math.max(0, range.endMs - range.startMs);
  const value = atMs ?? range?.endMs ?? 0;
  const fraction = range === null || span === 0 ? 1 : Math.min(1, Math.max(0, (value - range.startMs) / span));
  const playing = cursor.mode === 'playing' && !atEnd;
  const following = cursor.mode === 'live';
  const disabled = range === null;

  const clamp = (ms: number) => (range === null ? ms : Math.round(Math.min(range.endMs, Math.max(range.startMs, ms))));
  const fromPointer = (clientX: number): number => {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box || range === null || box.width <= 0) return value;
    return clamp(range.startMs + ((clientX - box.left) / box.width) * span);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { resume: playing, frame: 0, pending: null };
    onSeek(fromPointer(event.clientX), 'paused');
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    current.pending = fromPointer(event.clientX);
    if (current.frame !== 0) return;
    current.frame = requestAnimationFrame(() => {
      current.frame = 0;
      if (current.pending !== null && drag.current === current) onSeek(current.pending, 'paused');
      current.pending = null;
    });
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    if (current.frame !== 0) cancelAnimationFrame(current.frame);
    onSeek(fromPointer(event.clientX), current.resume ? 'playing' : 'paused');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (range === null) return;
    const { step, page } = scrubSteps(span);
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        next = value - step;
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        next = value + step;
        break;
      case 'PageDown':
        next = value - page;
        break;
      case 'PageUp':
        next = value + page;
        break;
      case 'Home':
        next = range.startMs;
        break;
      case 'End':
        next = range.endMs;
        break;
      default:
        return;
    }
    event.preventDefault();
    onSeek(clamp(next), 'keep');
  };

  const valueText = atMs === null ? 'No data yet' : timeValueText(atMs);
  const rangeText = rangePending === true ? 'Loading…' : range === null ? 'Waiting for data…' : `${formatUtcDate(range.startMs)}, ${formatUtcTime(range.startMs)}–${formatUtcTime(range.endMs)} UTC (${formatSpan(span)})`;
  return (
    <section className="time-bar" aria-label={`${label}: time`} data-testid="time-bar" data-mode={cursor.mode} data-at={atMs ?? undefined}>
      <div className="time-bar__controls">
        <Button
          variant="secondary"
          size="sm"
          onClick={playing ? onPause : onPlay}
          disabled={disabled}
          aria-label={playing ? 'Pause' : 'Play'}
          data-testid="time-play"
        >
          {playing ? 'Pause' : 'Play'}
        </Button>
        <div
          ref={trackRef}
          className="time-bar__track"
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Time shown on the map"
          aria-valuemin={range?.startMs ?? 0}
          aria-valuemax={range?.endMs ?? 0}
          aria-valuenow={value}
          aria-valuetext={valueText}
          aria-disabled={disabled || undefined}
          data-testid="time-slider"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyDown={onKeyDown}
        >
          <div className="time-bar__fill" style={{ width: `${(fraction * 100).toFixed(3)}%` }} />
          <div className="time-bar__thumb" style={{ left: `${(fraction * 100).toFixed(3)}%` }} />
        </div>
        <label className="time-bar__speed">
          <span className="gg-visually-hidden">Playback speed</span>
          <select value={String(cursor.speed)} onChange={(event) => onSpeed(Number(event.target.value))} data-testid="time-speed" disabled={disabled}>
            {[...new Set([...SPEEDS, cursor.speed])]
              .sort((a, b) => a - b)
              .map((speed) => (
                <option key={speed} value={String(speed)}>{`${speed}×`}</option>
              ))}
          </select>
        </label>
        {live && (
          <Button
            variant={following ? 'primary' : 'secondary'}
            size="sm"
            aria-pressed={following}
            onClick={following ? onPause : onLive}
            disabled={disabled}
            data-testid="time-live"
            title={following ? 'Following the live feed: click to hold this time' : 'Back to the newest data'}
          >
            {following ? 'Live' : 'Go live'}
          </Button>
        )}
      </div>
      <div className="time-bar__info">
        <span className="time-bar__now" data-testid="time-now">
          <strong>{atMs === null ? '–' : `${formatUtcTime(atMs)} UTC`}</strong>
          {atMs === null ? null : <span className="time-bar__local">{formatLocalTime(atMs)}</span>}
        </span>
        {expired === true && (
          <span className="time-bar__expired" role="status" data-testid="time-expired" title="The feed keeps the last hour; the time you paused at is older, so the map shows the oldest fixes kept">
            Paused · older data has expired
          </span>
        )}
        <span className="time-bar__range" data-testid="time-range">
          Data: {rangeText}
        </span>
        <span className="panel__spacer" />
        <label className="time-bar__follow">
          <input type="checkbox" checked={chartsFollow} onChange={(event) => onChartsFollow(event.target.checked)} data-testid="time-follow" disabled={disabled} />
          Charts follow time
        </label>
        {loadDay && (
          <span className="time-bar__day" data-state={loadDay.state} data-testid="time-day">
            {loadDay.state === 'loaded' ? (
              <span className="time-bar__day-note" data-testid="time-day-loaded">
                Full day loaded
              </span>
            ) : loadDay.state === 'failed' ? (
              <>
                <span className="time-bar__day-error" role="alert" title={loadDay.error} data-testid="time-day-error">
                  The full day didn’t load: {loadDay.error}
                </span>
                <Button variant="ghost" size="sm" className="gg-button--accent-text" onClick={loadDay.onLoad} data-testid="time-load-day">
                  Retry
                </Button>
                <Button variant="ghost" size="sm" onClick={loadDay.onBack} data-testid="time-day-back">
                  Back to 30 minutes
                </Button>
              </>
            ) : (
              <Button variant="ghost" size="sm" className="gg-button--accent-text" onClick={loadDay.onLoad} disabled={loadDay.state === 'loading'} data-testid="time-load-day">
                {loadDay.state === 'loading' ? 'Loading the full day…' : 'Load full day (14.5 MB)'}
              </Button>
            )}
          </span>
        )}
      </div>
    </section>
  );
}

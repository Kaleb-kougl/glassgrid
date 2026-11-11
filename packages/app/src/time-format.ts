/*
 * Time cursor helpers for the scrubber (milestone L4,
 * docs/live-flights-l4.md): the keyboard steps for a data range and T in
 * words, in UTC and the viewer's local time. Pure, so they are unit-tested
 * without a DOM.
 */

/** Step sizes the scrubber's keys use, in ms: 1 s to 1 h. */
const NICE_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1_800, 3_600].map((seconds) => seconds * 1_000);

/** The smallest nice step at least `ms` (at most an hour). */
export function niceStep(ms: number): number {
  return NICE_STEPS_MS.find((step) => step >= ms) ?? 3_600_000;
}

/**
 * The scrubber's keyboard steps for a data range: arrows move about 1/200
 * of it, Page Up / Page Down about 1/20 (30 minutes: 10 s and 2 min; a day:
 * 10 min and 1 h), both nice values.
 */
export function scrubSteps(rangeMs: number): { step: number; page: number } {
  const span = Math.max(1_000, rangeMs);
  const step = niceStep(span / 200);
  return { step, page: Math.max(step * 2, niceStep(span / 20)) };
}

const utcTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' });
const utcDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

/** `23:41:05` (UTC). */
export function formatUtcTime(ms: number): string {
  return utcTime.format(ms);
}

/** `Nov 9, 2026` (UTC). */
export function formatUtcDate(ms: number): string {
  return utcDate.format(ms);
}

/**
 * `15:41:05 PST` in the viewer's time zone (or `timeZone`, for tests), with
 * the local date in front when it is not the UTC date (`Nov 8, 16:05:00
 * PST` beside `00:05:00 UTC` on Nov 9), so a time near midnight is never
 * read as the wrong day.
 */
export function formatLocalTime(ms: number, timeZone?: string): string {
  const zone = timeZone === undefined ? {} : { timeZone };
  const time = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short', ...zone }).format(ms);
  const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...zone }).format(ms);
  if (date === utcDate.format(ms)) return time;
  const short = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...zone }).format(ms);
  return `${short}, ${time}`;
}

/** A length of time in words: `31 min`, `24 h`, `1 h 5 min`, `45 s`. */
export function formatSpan(ms: number): string {
  const seconds = Math.round(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** How long before T a fix was: `at T`, `12 s before`, `3 min before`. */
export function formatAge(fixMs: number, atMs: number): string {
  const ms = atMs - fixMs;
  if (ms < 1_000) return 'at this time';
  return `${formatSpan(ms)} earlier`;
}

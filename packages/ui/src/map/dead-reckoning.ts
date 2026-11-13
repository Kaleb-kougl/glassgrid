/*
 * Dead reckoning for the map: where an aircraft is drawn between fixes.
 * Pure functions, no DOM, no MapLibre (unit- and property-tested in
 * dead-reckoning.test.ts). docs/live-flights-l3-map.md has the maths.
 *
 * - A fix is moved along its track at its ground speed for the time since
 *   it was taken, on the feed's data clock:
 *     elapsed = (dataClockMs − ts) + wall × speed
 *   where `wall` is the real time since the rows arrived while playing
 *   (`PlaybackClock`). Elapsed is clamped to [0, 60 s].
 * - No extrapolation without a ground speed or a track, or on the ground.
 * - When new rows arrive, each aircraft eases from where it was drawn to
 *   its new extrapolated position over 1 s (ease-out cubic), so nothing
 *   jumps; offsets over 5 km snap instead (a new leg, a bad fix).
 */

/** Never extrapolate a fix by more than this (data time). */
export const MAX_EXTRAPOLATION_MS = 60_000;
/** How long the hand-over from the drawn position to a new fix takes (wall time). */
export const EASE_MS = 1_000;
/** Offsets larger than this snap instead of easing. */
export const SNAP_DISTANCE_M = 5_000;

const KT_TO_MPS = 1852 / 3600;
const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

export interface Fix {
  readonly lat: number;
  readonly lon: number;
  readonly gsKt: number | null;
  readonly trackDeg: number | null;
  readonly onGround: boolean;
  /** Epoch ms of the fix. */
  readonly ts: number;
}

export interface Placement {
  readonly lat: number;
  readonly lon: number;
  /** Degrees clockwise from true north, or null when unknown. */
  readonly trackDeg: number | null;
}

/** True when the fix may be moved: airborne, with a finite, non-negative speed and a finite track. */
export function canExtrapolate(fix: Fix): boolean {
  return !fix.onGround && fix.gsKt !== null && Number.isFinite(fix.gsKt) && fix.gsKt >= 0 && fix.trackDeg !== null && Number.isFinite(fix.trackDeg);
}

/** Data time to extrapolate `fix` by: (dataClock − ts) + wallElapsed, clamped to [0, MAX_EXTRAPOLATION_MS]. NaN → 0. */
export function extrapolationMs(dataClockMs: number, ts: number, wallElapsedMs: number): number {
  const elapsed = dataClockMs - ts + wallElapsedMs;
  if (!(elapsed > 0)) return 0;
  return Math.min(MAX_EXTRAPOLATION_MS, elapsed);
}

/**
 * The fix moved `elapsedMs` along its track (a local flat-earth step: over
 * 60 s at 600 kt, about 18.5 km, the error is under a metre). Fixes that
 * may not be extrapolated stay where they are. `elapsedMs` is clamped like
 * `extrapolationMs`.
 */
export function extrapolate(fix: Fix, elapsedMs: number): Placement {
  const trackDeg = fix.trackDeg !== null && Number.isFinite(fix.trackDeg) ? fix.trackDeg : null;
  if (!canExtrapolate(fix)) return { lat: fix.lat, lon: fix.lon, trackDeg };
  const ms = Number.isFinite(elapsedMs) ? Math.max(0, Math.min(MAX_EXTRAPOLATION_MS, elapsedMs)) : 0;
  const distance = (fix.gsKt as number) * KT_TO_MPS * (ms / 1000);
  if (distance === 0) return { lat: fix.lat, lon: fix.lon, trackDeg };
  const track = (trackDeg as number) * DEG;
  const north = distance * Math.cos(track);
  const east = distance * Math.sin(track);
  const lat = fix.lat + (north / EARTH_RADIUS_M) / DEG;
  const cosLat = Math.cos(fix.lat * DEG);
  const lon = fix.lon + (Math.abs(cosLat) < 1e-9 ? 0 : east / (EARTH_RADIUS_M * cosLat) / DEG);
  return { lat: Math.max(-90, Math.min(90, lat)), lon, trackDeg };
}

/** Distance in metres between two placements (equirectangular; exact enough below 100 km). */
export function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const x = (b.lon - a.lon) * DEG * Math.cos(((a.lat + b.lat) / 2) * DEG);
  const y = (b.lat - a.lat) * DEG;
  return Math.hypot(x, y) * EARTH_RADIUS_M;
}

// --- Playback clock -----------------------------------------------------------------

/**
 * Wall time since the current rows arrived, scaled by speed, advancing only
 * while playing: `carriedMs` holds what accumulated before the last
 * play/pause or speed change, `since` when the current stretch started.
 */
export interface PlaybackClock {
  readonly playing: boolean;
  readonly speed: number;
  readonly since: number;
  readonly carriedMs: number;
}

/** A speed multiplier: finite and ≥ 0, else 1 (undefined is the default 1). */
export function sanitizeSpeed(speed: number | undefined): number {
  return speed !== undefined && Number.isFinite(speed) && speed >= 0 ? speed : 1;
}

export function startClock(now: number, playing: boolean, speed: number | undefined): PlaybackClock {
  return { playing, speed: sanitizeSpeed(speed), since: now, carriedMs: 0 };
}

/** Scaled wall time at `now` (never negative, never decreasing for a fixed clock and a later `now`). */
export function clockElapsed(clock: PlaybackClock, now: number): number {
  if (!clock.playing) return clock.carriedMs;
  return clock.carriedMs + Math.max(0, now - clock.since) * clock.speed;
}

/** The clock with a new play state and speed from `now` on; what elapsed so far is kept. */
export function updateClock(clock: PlaybackClock, now: number, playing: boolean, speed: number | undefined): PlaybackClock {
  const nextSpeed = sanitizeSpeed(speed);
  if (clock.playing === playing && clock.speed === nextSpeed) return clock;
  return { playing, speed: nextSpeed, since: now, carriedMs: clockElapsed(clock, now) };
}

// --- Easing --------------------------------------------------------------------------

export function easeOutCubic(t: number): number {
  const c = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 1));
  return 1 - (1 - c) ** 3;
}

/** How much of an offset is left at `now`: 1 at `start`, 0 from `start + EASE_MS` on. */
export function easeRemaining(start: number, now: number, durationMs: number = EASE_MS): number {
  if (!(durationMs > 0)) return 0;
  return 1 - easeOutCubic((now - start) / durationMs);
}

/** `a − b` in degrees, wrapped to (−180, 180]. */
export function angleDelta(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d <= -180) d += 360;
  if (d > 180) d -= 360;
  return d;
}

/** What is added to the extrapolated position while easing: the old drawn position minus the new target at hand-over. */
export interface EaseOffset {
  readonly dLat: number;
  readonly dLon: number;
  readonly dTrack: number;
  readonly start: number;
}

/**
 * The offset that hands `drawn` over to `target` (both at `now`), or null
 * when there is nothing to ease (no previous position, non-finite input,
 * or a jump beyond SNAP_DISTANCE_M).
 */
export function easeOffset(drawn: Placement | null | undefined, target: Placement, now: number): EaseOffset | null {
  if (!drawn || !Number.isFinite(drawn.lat) || !Number.isFinite(drawn.lon)) return null;
  if (distanceM(drawn, target) > SNAP_DISTANCE_M) return null;
  const dTrack = drawn.trackDeg !== null && target.trackDeg !== null ? angleDelta(drawn.trackDeg, target.trackDeg) : 0;
  const dLat = drawn.lat - target.lat;
  const dLon = drawn.lon - target.lon;
  if (dLat === 0 && dLon === 0 && dTrack === 0) return null;
  return { dLat, dLon, dTrack, start: now };
}

/** `target` plus what is left of `offset` at `now`. */
export function applyEase(target: Placement, offset: EaseOffset | null, now: number): Placement {
  if (!offset) return target;
  const k = easeRemaining(offset.start, now);
  if (k <= 0) return target;
  const trackDeg = target.trackDeg === null ? null : (((target.trackDeg + offset.dTrack * k) % 360) + 360) % 360;
  return { lat: target.lat + offset.dLat * k, lon: target.lon + offset.dLon * k, trackDeg };
}

/** True while an offset still moves the drawn position. */
export function isEasing(offset: EaseOffset | null, now: number): boolean {
  return offset !== null && now - offset.start < EASE_MS;
}

/** Where a fix is drawn at `now`: extrapolated on the data clock, then eased. */
export function placementAt(fix: Fix, offset: EaseOffset | null, dataClockMs: number, clock: PlaybackClock, now: number): Placement {
  const target = extrapolate(fix, extrapolationMs(dataClockMs, fix.ts, clockElapsed(clock, now)));
  return applyEase(target, offset, now);
}

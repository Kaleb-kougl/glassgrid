/**
 * @vitest-environment node
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  angleDelta,
  applyEase,
  canExtrapolate,
  clockElapsed,
  distanceM,
  EASE_MS,
  easeOffset,
  easeOutCubic,
  easeRemaining,
  extrapolate,
  extrapolationMs,
  isEasing,
  MAX_EXTRAPOLATION_MS,
  placementAt,
  sanitizeSpeed,
  SNAP_DISTANCE_M,
  startClock,
  updateClock,
  type Fix,
} from './dead-reckoning';

const SFO = { lat: 37.6198, lon: -122.3748 };
const fix = (over: Partial<Fix> = {}): Fix => ({ lat: SFO.lat, lon: SFO.lon, gsKt: 300, trackDeg: 90, onGround: false, ts: 1_000_000, ...over });

const arbFix = fc.record({
  lat: fc.double({ min: -80, max: 80, noNaN: true }),
  lon: fc.double({ min: -179, max: 179, noNaN: true }),
  gsKt: fc.option(fc.double({ min: 0, max: 700, noNaN: true }), { nil: null }),
  trackDeg: fc.option(fc.double({ min: -720, max: 720, noNaN: true }), { nil: null }),
  onGround: fc.boolean(),
  ts: fc.integer({ min: 0, max: 2_000_000_000_000 }),
});
const anyNumber = fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(Infinity), fc.constant(-Infinity));

describe('extrapolation', () => {
  it('moves along the track at the ground speed: 300 kt east for 60 s is 9,260 m', () => {
    const p = extrapolate(fix(), 60_000);
    expect(distanceM(SFO, p)).toBeCloseTo(9_260, -1);
    expect(p.lat).toBeCloseTo(SFO.lat, 6);
    expect(p.lon).toBeGreaterThan(SFO.lon);
    const north = extrapolate(fix({ trackDeg: 0 }), 10_000);
    expect(north.lon).toBeCloseTo(SFO.lon, 9);
    expect(north.lat).toBeGreaterThan(SFO.lat);
  });

  it('stays put on the ground, without a speed or without a track', () => {
    for (const f of [fix({ onGround: true }), fix({ gsKt: null }), fix({ trackDeg: null }), fix({ gsKt: Number.NaN })]) {
      expect(canExtrapolate(f)).toBe(false);
      expect(extrapolate(f, 30_000)).toMatchObject({ lat: f.lat, lon: f.lon });
    }
  });

  it('elapsed is (data clock − fix time) + wall, clamped to [0, 60 s]', () => {
    expect(extrapolationMs(10_000, 4_000, 1_500)).toBe(7_500);
    expect(extrapolationMs(10_000, 20_000, 0)).toBe(0);
    expect(extrapolationMs(1_000_000, 0, 0)).toBe(MAX_EXTRAPOLATION_MS);
    expect(extrapolationMs(Number.NaN, 0, 0)).toBe(0);
  });

  it('property: zero ground speed never moves', () => {
    fc.assert(
      fc.property(arbFix, fc.double({ min: -1e6, max: 1e6, noNaN: true }), (f, ms) => {
        const p = extrapolate({ ...f, gsKt: 0 }, ms);
        expect(p.lat).toBe(f.lat);
        expect(p.lon).toBe(f.lon);
      }),
      { numRuns: 400 },
    );
  });

  it('property: positions stay finite for any elapsed time and any fix', () => {
    fc.assert(
      fc.property(arbFix, anyNumber, anyNumber, anyNumber, (f, clock, wall, raw) => {
        for (const ms of [extrapolationMs(clock, f.ts, wall), raw]) {
          const p = extrapolate(f, ms);
          expect(Number.isFinite(p.lat) && Number.isFinite(p.lon)).toBe(true);
          expect(Math.abs(p.lat)).toBeLessThanOrEqual(90);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('property: the cap holds: never farther than 60 s at the ground speed, and no farther past it', () => {
    fc.assert(
      fc.property(arbFix, fc.double({ min: 0, max: 1e7, noNaN: true }), (f, ms) => {
        const moved = distanceM(f, extrapolate(f, ms));
        const capped = distanceM(f, extrapolate(f, MAX_EXTRAPOLATION_MS));
        const limit = (f.gsKt ?? 0) * (1852 / 3600) * (MAX_EXTRAPOLATION_MS / 1000);
        expect(moved).toBeLessThanOrEqual(limit * 1.001 + 1e-6);
        if (ms >= MAX_EXTRAPOLATION_MS) expect(moved).toBeCloseTo(capped, 6);
        expect(extrapolationMs(f.ts + ms, f.ts, ms)).toBeLessThanOrEqual(MAX_EXTRAPOLATION_MS);
      }),
      { numRuns: 400 },
    );
  });
});

describe('playback clock', () => {
  it('advances only while playing, scaled by speed, and keeps what elapsed across pauses and speed changes', () => {
    let clock = startClock(1_000, true, 2);
    expect(clockElapsed(clock, 1_500)).toBe(1_000);
    clock = updateClock(clock, 1_500, false, 2);
    expect(clockElapsed(clock, 9_000)).toBe(1_000);
    clock = updateClock(clock, 9_000, true, 4);
    expect(clockElapsed(clock, 9_250)).toBe(2_000);
    expect(updateClock(clock, 9_250, true, 4)).toBe(clock);
  });

  it('treats a missing, negative or non-finite speed as 1, and 0 as standing still', () => {
    expect(sanitizeSpeed(undefined)).toBe(1);
    expect(sanitizeSpeed(-2)).toBe(1);
    expect(sanitizeSpeed(Number.NaN)).toBe(1);
    expect(sanitizeSpeed(0)).toBe(0);
    expect(clockElapsed(startClock(0, true, 0), 5_000)).toBe(0);
  });

  it('property: elapsed is never negative and never decreases', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 64, noNaN: true }), fc.boolean(), fc.array(fc.double({ min: 0, max: 10_000, noNaN: true }), { maxLength: 20 }), (speed, playing, steps) => {
        const clock = startClock(0, playing, speed);
        let now = 0;
        let last = clockElapsed(clock, now);
        for (const step of steps) {
          now += step;
          const e = clockElapsed(clock, now);
          expect(e).toBeGreaterThanOrEqual(last);
          last = e;
        }
        expect(clockElapsed(clock, now - 1e9)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('a paused map does not move: placements are the same at any later time', () => {
    const clock = startClock(0, false, 1);
    const a = placementAt(fix(), null, 1_005_000, clock, 0);
    const b = placementAt(fix(), null, 1_005_000, clock, 123_456);
    expect(b).toEqual(a);
  });
});

describe('easing', () => {
  it('ease-out cubic runs from 0 to 1 and clamps', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(2)).toBe(1);
    expect(easeOutCubic(-1)).toBe(0);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 9);
    expect(easeRemaining(100, 100)).toBe(1);
    expect(easeRemaining(100, 100 + EASE_MS)).toBe(0);
  });

  it('hands over without a jump: at hand-over the drawn position is the old one, after 1 s the new target', () => {
    const drawn = { lat: 37.62, lon: -122.37, trackDeg: 350 };
    const target = { lat: 37.621, lon: -122.369, trackDeg: 10 };
    const offset = easeOffset(drawn, target, 5_000);
    expect(offset).not.toBeNull();
    const at0 = applyEase(target, offset, 5_000);
    expect(at0.lat).toBeCloseTo(drawn.lat, 12);
    expect(at0.lon).toBeCloseTo(drawn.lon, 12);
    expect(at0.trackDeg).toBeCloseTo(350, 9);
    // The short way round: 350° → 10° passes through 0°, not 180°.
    expect(applyEase(target, offset, 5_100).trackDeg ?? 0).toBeGreaterThan(350);
    expect(applyEase(target, offset, 5_000 + EASE_MS)).toEqual(target);
    expect(isEasing(offset, 5_999)).toBe(true);
    expect(isEasing(offset, 6_000)).toBe(false);
  });

  it('snaps instead of easing across more than 5 km, or from nowhere', () => {
    const target = { lat: 37.62, lon: -122.37, trackDeg: 0 };
    expect(easeOffset({ lat: 37.7, lon: -122.37, trackDeg: 0 }, target, 0)).toBeNull();
    expect(SNAP_DISTANCE_M).toBe(5_000);
    expect(easeOffset(null, target, 0)).toBeNull();
    expect(easeOffset(target, target, 0)).toBeNull();
  });

  it('property: easing converges monotonically to the target within EASE_MS', () => {
    const place = fc.record({ lat: fc.double({ min: 36, max: 39, noNaN: true }), lon: fc.double({ min: -124, max: -121, noNaN: true }), trackDeg: fc.option(fc.double({ min: 0, max: 359.9, noNaN: true }), { nil: null }) });
    fc.assert(
      fc.property(place, place, fc.integer({ min: 0, max: 1e9 }), (drawn, target, start) => {
        const offset = easeOffset(drawn, target, start);
        let previous = Infinity;
        for (let t = 0; t <= EASE_MS; t += 50) {
          const p = applyEase(target, offset, start + t);
          expect(Number.isFinite(p.lat) && Number.isFinite(p.lon)).toBe(true);
          const d = distanceM(p, target);
          expect(d).toBeLessThanOrEqual(previous + 1e-6);
          previous = d;
        }
        expect(distanceM(applyEase(target, offset, start + EASE_MS), target)).toBe(0);
        if (offset) expect(distanceM(applyEase(target, offset, start), drawn)).toBeLessThan(1e-3);
      }),
      { numRuns: 300 },
    );
  });

  it('angleDelta wraps to (−180, 180]', () => {
    expect(angleDelta(350, 10)).toBe(-20);
    expect(angleDelta(10, 350)).toBe(20);
    expect(angleDelta(180, 0)).toBe(180);
    expect(angleDelta(0, 180)).toBe(180);
    fc.assert(
      fc.property(fc.double({ min: -1e4, max: 1e4, noNaN: true }), fc.double({ min: -1e4, max: 1e4, noNaN: true }), (a, b) => {
        const d = angleDelta(a, b);
        expect(d).toBeGreaterThan(-180);
        expect(d).toBeLessThanOrEqual(180);
      }),
    );
  });
});

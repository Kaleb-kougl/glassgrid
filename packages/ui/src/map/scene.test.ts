/**
 * @vitest-environment node
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { tokensFor } from '../tokens';
import { ALTITUDE_BANDS, altitudeClass, altitudeFt, altitudeLegend } from './altitude';
import { EASE_MS } from './dead-reckoning';
import { pickNearest } from './hit';
import { latOfMercatorY, lonOfMercatorX, mercatorX, mercatorY, ORIGIN_X, ORIGIN_Y, relativeMatrix } from './mercator';
import { AircraftScene, PLANE_RADIUS, PLANE_RADIUS_SELECTED, RING_RADIUS, TRACK_MAX_GAP_MS, TRAIL_MIN_STEP_MS, VERTEX_FLOATS } from './scene';
import type { MapAircraft, MapTrailPoint } from './types';

const T0 = Date.UTC(2026, 10, 9, 23, 27, 30);

function aircraft(over: Partial<MapAircraft> = {}): MapAircraft {
  return { hex: 'a1b2c3', flight: 'UAL1', typeCode: 'B738', category: 'A3', lat: 37.6, lon: -122.3, altBaroFt: 12_000, altGeomFt: null, onGround: false, gsKt: 360, trackDeg: 90, baroRateFpm: 0, ts: T0, ...over };
}

function trail(hex: string, from: number, to: number, stepMs = 2_000): MapTrailPoint[] {
  const out: MapTrailPoint[] = [];
  for (let ts = from; ts <= to; ts += stepMs) out.push({ hex, ts, lat: 37.6, lon: -122.4 + (ts - from) / 1e7, altBaroFt: 12_000 });
  return out;
}

/** Decoded glyph vertices (the first of each quad). */
function glyphs(scene: AircraftScene, now: number) {
  const data = scene.glyphs(now);
  return Array.from({ length: data.quads }, (_, q) => {
    const f = q * 4 * VERTEX_FLOATS;
    const x = (data.floats[f] ?? 0) + ORIGIN_X;
    const y = (data.floats[f + 1] ?? 0) + ORIGIN_Y;
    return { lon: lonOfMercatorX(x), lat: latOfMercatorY(y), angle: data.floats[f + 4] ?? 0, radius: data.floats[f + 5] ?? 0, kind: data.floats[f + 6] ?? 0, rgb: [...data.bytes.slice(q * 4 * 32 + 28, q * 4 * 32 + 31)] };
  });
}

describe('mercator helpers', () => {
  it('round-trips and folds the origin into the matrix exactly', () => {
    fc.assert(
      fc.property(fc.double({ min: -179, max: 179, noNaN: true }), fc.double({ min: -80, max: 80, noNaN: true }), (lon, lat) => {
        expect(lonOfMercatorX(mercatorX(lon))).toBeCloseTo(lon, 9);
        expect(latOfMercatorY(mercatorY(lat))).toBeCloseTo(lat, 9);
      }),
    );
    // M × T(o) applied to (p − o) equals M applied to p.
    const m = [2, 0.5, 0, 0, -0.25, 3, 0, 0, 0, 0, 1, 0, 0.1, -0.2, 0, 1];
    const out = relativeMatrix(m, 0.2, 0.4);
    const apply = (mat: ArrayLike<number>, x: number, y: number) => [0, 1, 3].map((r) => (mat[r] ?? 0) * x + (mat[4 + r] ?? 0) * y + (mat[12 + r] ?? 0));
    const direct = apply(m, 0.25, 0.45);
    const relative = apply(out, 0.05, 0.05);
    direct.forEach((v, i) => expect(relative[i]).toBeCloseTo(v, 6));
  });
});

describe('AircraftScene', () => {
  it('writes one quad per aircraft at its fix, rotated by track, coloured by altitude band, ground traffic as rings', () => {
    const scene = new AircraftScene('light', 0);
    scene.setData([aircraft(), aircraft({ hex: 'g1', onGround: true, altBaroFt: null, gsKt: 0, trackDeg: 180 })], [], T0, 0);
    const out = glyphs(scene, 0);
    expect(out).toHaveLength(2);
    // Ground first (drawn under), then airborne.
    expect(out[0]?.kind).toBe(1);
    expect(out[0]?.radius).toBe(RING_RADIUS);
    expect(out[1]?.kind).toBe(0);
    expect(out[1]?.radius).toBe(PLANE_RADIUS);
    expect(out[1]?.angle).toBeCloseTo(Math.PI / 2, 6);
    expect(out[1]?.lat).toBeCloseTo(37.6, 6);
    expect(out[1]?.lon).toBeCloseTo(-122.3, 6);
    const hexOf = (rgb: number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    expect(hexOf(out[1]?.rgb ?? [])).toBe(tokensFor('light').chart.altitude[3]);
    expect(hexOf(out[0]?.rgb ?? [])).toBe(tokensFor('light').chart.altGround);
  });

  it('dead-reckons while playing and stands still while paused', () => {
    const scene = new AircraftScene('light', 0);
    scene.setPlayback(true, 1, 0);
    scene.setData([aircraft()], [], T0, 0);
    const lon0 = glyphs(scene, 0)[0]?.lon ?? 0;
    const lon10 = glyphs(scene, 10_000)[0]?.lon ?? 0;
    expect(lon10).toBeGreaterThan(lon0); // eastbound
    expect(scene.isAnimating(10_000)).toBe(true);
    scene.setPlayback(false, 1, 10_000);
    expect(glyphs(scene, 50_000)[0]?.lon).toBeCloseTo(lon10, 9);
    expect(scene.isAnimating(50_000)).toBe(false);
  });

  it('eases from the drawn position to a new fix instead of jumping', () => {
    const scene = new AircraftScene('light', 0);
    scene.setData([aircraft()], [], T0, 0);
    const before = glyphs(scene, 1_000)[0];
    // The next poll puts it 500 m further north.
    scene.setData([aircraft({ lat: 37.6045, ts: T0 + 1_000 })], [], T0 + 1_000, 1_000);
    const at = glyphs(scene, 1_000)[0];
    expect(at?.lat).toBeCloseTo(before?.lat ?? 0, 9);
    expect(scene.isAnimating(1_500)).toBe(true);
    expect(glyphs(scene, 1_000 + EASE_MS)[0]?.lat).toBeCloseTo(37.6045, 7); // float32 vertices: ~1e-9 of a degree
    expect(scene.isAnimating(1_000 + EASE_MS)).toBe(false);
  });

  it('draws the selected aircraft last, bigger and flagged', () => {
    const scene = new AircraftScene('dark', 0);
    scene.setData([aircraft({ hex: 'a', altBaroFt: 40_000 }), aircraft({ hex: 'b', altBaroFt: 500 })], [], T0, 0);
    expect(glyphs(scene, 0).map((g) => g.kind)).toEqual([0, 0]);
    scene.setSelected('a');
    const out = glyphs(scene, 0);
    expect(out[1]?.kind).toBe(2);
    expect(out[1]?.radius).toBe(PLANE_RADIUS_SELECTED);
    expect(scene.placements(0).map((p) => p.hex)).toEqual(['b', 'a']);
  });

  it('thins straight trails to one point per 8 s, keeps each last point, breaks gaps, and only for aircraft on the map', () => {
    const scene = new AircraftScene('light', 0);
    const points = [...trail('a1b2c3', T0 - 60_000, T0), ...trail('gone', T0 - 60_000, T0)];
    scene.setData([aircraft()], points, T0, 0);
    const segments = scene.trails().quads;
    const thinned = (spanMs: number) => Math.floor(spanMs / TRAIL_MIN_STEP_MS);
    expect(segments).toBe(thinned(60_000));
    // A 2-minute hole: no line across it.
    const holed = [...trail('a1b2c3', T0 - 280_000, T0 - 200_000), ...trail('a1b2c3', T0 - 60_000, T0)];
    scene.setData([aircraft()], holed, T0, 0);
    expect(scene.trails().quads).toBe(thinned(80_000) + thinned(60_000));
    // One connector from the last trail point to the drawn aircraft.
    expect(scene.connectors(0).quads).toBe(1);
    // Unsorted input is sorted, not trusted.
    scene.setData([aircraft()], [...trail('a1b2c3', T0 - 60_000, T0)].reverse(), T0, 0);
    expect(scene.trails().quads).toBe(thinned(60_000));
  });

  it('keeps more points in a turn, so curves stay round', () => {
    const scene = new AircraftScene('light', 0);
    // A standard-rate turn (3 °/s) at 150 kt, a fix every 2 s for 60 s.
    const points: MapTrailPoint[] = [];
    let lat = 37.6;
    let lon = -122.3;
    for (let k = 0, heading = 0; k <= 30; k += 1, heading += 6) {
      points.push({ hex: 'a1b2c3', ts: T0 - 60_000 + k * 2_000, lat, lon, altBaroFt: 3_000 });
      const step = (150 * 1852) / 3600 * 2; // metres per 2 s
      lat += (step * Math.cos((heading * Math.PI) / 180)) / 111_195;
      lon += (step * Math.sin((heading * Math.PI) / 180)) / (111_195 * Math.cos((37.6 * Math.PI) / 180));
    }
    scene.setData([aircraft()], points, T0, 0);
    const turning = scene.trails().quads;
    expect(turning).toBeGreaterThan(Math.floor(60_000 / TRAIL_MIN_STEP_MS));
    expect(turning).toBeLessThanOrEqual(30);
  });

  it('property: every vertex it writes is finite, for any input rows', () => {
    const arbAircraft = fc.record({
      hex: fc.constantFrom('a', 'b', 'c', 'd'),
      flight: fc.constant(null),
      typeCode: fc.constant(null),
      category: fc.constant(null),
      lat: fc.double({ min: 36, max: 39, noNaN: true }),
      lon: fc.double({ min: -124, max: -121, noNaN: true }),
      altBaroFt: fc.option(fc.integer({ min: -1_000, max: 60_000 }), { nil: null }),
      altGeomFt: fc.option(fc.integer({ min: -1_000, max: 60_000 }), { nil: null }),
      onGround: fc.boolean(),
      gsKt: fc.option(fc.double({ min: 0, max: 700, noNaN: true }), { nil: null }),
      trackDeg: fc.option(fc.double({ min: 0, max: 360, noNaN: true }), { nil: null }),
      baroRateFpm: fc.constant(null),
      ts: fc.integer({ min: T0 - 120_000, max: T0 + 5_000 }),
    });
    const arbTrail = fc.record({ hex: fc.constantFrom('a', 'b', 'c', 'd'), ts: fc.integer({ min: T0 - 400_000, max: T0 }), lat: fc.double({ min: 36, max: 39, noNaN: true }), lon: fc.double({ min: -124, max: -121, noNaN: true }), altBaroFt: fc.option(fc.integer({ min: 0, max: 45_000 }), { nil: null }) });
    fc.assert(
      fc.property(fc.array(arbAircraft, { maxLength: 6 }), fc.array(arbTrail, { maxLength: 60 }), fc.double({ min: 0, max: 100_000, noNaN: true }), (rows, points, now) => {
        const scene = new AircraftScene('light', 0);
        scene.setPlayback(true, 4, 0);
        scene.setData(rows, points, T0, 0);
        for (const data of [scene.glyphs(now), scene.trails(), scene.connectors(now)]) {
          const used = data.floats.subarray(0, data.quads * 4 * VERTEX_FLOATS);
          for (let i = 0; i < used.length; i += VERTEX_FLOATS) for (let k = 0; k < 7; k += 1) expect(Number.isFinite(used[i + k])).toBe(true);
        }
        expect(Number.isFinite(scene.trailTimeAt(now))).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('altitude bands', () => {
  it('bands by barometric altitude, else geometric; ground and unknown apart', () => {
    expect(altitudeFt({ altBaroFt: 3_000, altGeomFt: 3_200 })).toBe(3_000);
    expect(altitudeFt({ altBaroFt: null, altGeomFt: 3_200 })).toBe(3_200);
    expect(altitudeClass(null, true)).toBe('ground');
    expect(altitudeClass(null, false)).toBe('unknown');
    expect([-200, 999, 1_000, 4_999, 5_000, 10_000, 29_999, 30_000, 45_000].map((ft) => altitudeClass(ft, false))).toEqual([0, 0, 1, 1, 2, 3, 4, 5, 5]);
    expect(ALTITUDE_BANDS).toHaveLength(tokensFor('light').chart.altitude.length);
  });

  it('the legend lists every band high first, then ground and unknown, with the token colours', () => {
    const legend = altitudeLegend('dark');
    expect(legend.map((e) => e.key)).toEqual(['band-6', 'band-5', 'band-4', 'band-3', 'band-2', 'band-1', 'ground', 'unknown']);
    expect(legend[0]?.color).toBe(tokensFor('dark').chart.altitude[5]);
    expect(legend.find((e) => e.key === 'ground')?.shape).toBe('ring');
  });
});

describe('pickNearest', () => {
  it('returns the closest point within the radius, the later one on a tie, or null', () => {
    const points = [
      { hex: 'a', x: 100, y: 100 },
      { hex: 'b', x: 110, y: 100 },
      { hex: 'c', x: 110, y: 100 },
    ];
    expect(pickNearest(points, 102, 100)).toBe('a');
    expect(pickNearest(points, 109, 100)).toBe('c');
    expect(pickNearest(points, 300, 300)).toBeNull();
    expect(pickNearest([{ hex: 'n', x: Number.NaN, y: 0 }], 0, 0)).toBeNull();
  });
});

describe('the selected track (L4)', () => {
  it('draws only the selected aircraft’s points, thinned like trails, opaque in the selection colour, broken at long gaps', () => {
    const scene = new AircraftScene('light', 0);
    scene.setData([aircraft()], trail('a1b2c3', T0 - 60_000, T0), T0, 0);
    // An hour of fixes every 2 s, a gap of 10 minutes, then 5 more minutes; and another aircraft's points.
    const before = trail('a1b2c3', T0 - 3_600_000, T0 - 900_000);
    const after = trail('a1b2c3', T0 - 300_000, T0);
    const other = trail('ffffff', T0 - 300_000, T0);
    scene.setTrack([...after, ...other, ...before]);
    expect(scene.track().quads).toBe(0);
    const version = scene.trackVersion;
    scene.setSelected('a1b2c3');
    const data = scene.track();
    expect(scene.trackVersion).toBeGreaterThan(version);
    const points = scene.trackPoints();
    // Sorted, every 8 s (straight line), first and last kept.
    expect(points[0]?.ts).toBe(T0 - 3_600_000);
    expect(points.at(-1)?.ts).toBe(T0);
    expect(points.every((p, i) => i === 0 || p.ts > (points[i - 1]?.ts ?? 0))).toBe(true);
    expect(points.length).toBeLessThan((before.length + after.length) / 3);
    // One segment fewer than points, minus the one across the 10-minute gap.
    expect(TRACK_MAX_GAP_MS).toBe(300_000);
    expect(data.quads).toBe(points.length - 2);
    // Opaque, in the selection stroke colour, at time 0 (so the trail shader never fades it).
    const selection = scene.selection;
    for (let q = 0; q < data.quads; q += 1) {
      const v = q * 4;
      expect([...data.bytes.slice(v * 32 + 28, v * 32 + 32)]).toEqual([...selection, 255]);
      expect(data.floats[v * VERTEX_FLOATS + 6]).toBe(0);
    }
    // The same array again is no change; a new one rebuilds; none clears.
    const v2 = scene.trackVersion;
    scene.setTrack([...after, ...other, ...before]);
    scene.track();
    expect(scene.trackVersion).toBe(v2 + 1);
    scene.setTrack(undefined);
    expect(scene.track().quads).toBe(0);
  });
});

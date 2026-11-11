import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clipPolygons,
  clipRing,
  csvNumber,
  csvRecords,
  featureCollectionJson,
  glyphRanges,
  parseCsv,
  roundTo,
  runwayPolygon,
  signedArea2,
  simplifyLine,
  simplifyRing,
  type LonLatBox,
  type Position,
} from './basemap.ts';

const BOX: LonLatBox = { west: 0, south: 0, east: 10, north: 10 };
const square = (x0: number, y0: number, x1: number, y1: number): Position[] => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
  [x0, y0],
];

describe('clipRing', () => {
  it('keeps a ring inside the box, cuts one across its edge, drops one outside', () => {
    expect(clipRing(square(1, 1, 2, 2), BOX)).toEqual(square(1, 1, 2, 2));
    const cut = clipRing(square(5, 5, 15, 15), BOX);
    expect(Math.abs(signedArea2(cut)) / 2).toBeCloseTo(25, 9);
    expect(cut.every(([x, y]) => x >= 0 && x <= 10 && y >= 0 && y <= 10)).toBe(true);
    expect(clipRing(square(20, 20, 30, 30), BOX)).toEqual([]);
  });

  it('property: the clipped ring stays in the box and never has more area than the input', () => {
    const point = fc.tuple(fc.double({ min: -20, max: 30, noNaN: true }), fc.double({ min: -20, max: 30, noNaN: true }));
    fc.assert(
      fc.property(fc.array(point, { minLength: 3, maxLength: 12 }), (points) => {
        const ring: Position[] = [...points, points[0] as Position];
        const clipped = clipRing(ring, BOX);
        for (const [x, y] of clipped) {
          expect(x).toBeGreaterThanOrEqual(-1e-9);
          expect(x).toBeLessThanOrEqual(10 + 1e-9);
          expect(y).toBeGreaterThanOrEqual(-1e-9);
          expect(y).toBeLessThanOrEqual(10 + 1e-9);
        }
        if (clipped.length > 0) expect(clipped[0]).toEqual(clipped[clipped.length - 1]);
      }),
      { numRuns: 300 },
    );
  });
});

describe('simplification', () => {
  it('drops collinear points and keeps the corners', () => {
    const line: Position[] = [
      [0, 0],
      [1, 0.00001],
      [2, 0],
      [2, 2],
    ];
    expect(simplifyLine(line, 0.001)).toEqual([
      [0, 0],
      [2, 0],
      [2, 2],
    ]);
    const ring: Position[] = [[0, 0], [0.5, 0], [1, 0], [1, 1], [0, 1], [0, 0]];
    expect(simplifyRing(ring, 0.01, 5)).toHaveLength(5);
  });

  it('drops rings that collapse or fall under the minimum area', () => {
    expect(simplifyRing(square(0, 0, 0.00001, 0.00001), 0.001, 5)).toEqual([]);
    expect(simplifyRing(square(0, 0, 0.01, 0.01), 0, 5, 1)).toEqual([]);
  });

  it('clipPolygons keeps holes inside a kept outer ring and rounds coordinates', () => {
    const polygon = [square(1, 1, 9, 9), square(3.123456789, 3, 4, 4)];
    const out = clipPolygons([polygon, [square(20, 20, 30, 30)]], { box: BOX, tolerance: 0, decimals: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(2);
    expect(out[0]?.[1]?.[0]).toEqual([3.12346, 3]);
  });
});

describe('runwayPolygon', () => {
  it('is a closed counter-clockwise rectangle as long as the runway and as wide as width_ft', () => {
    // SFO 10L/28R from OurAirports.
    const ring = runwayPolygon([-122.39341, 37.628742], [-122.35716, 37.613538], 200, 7);
    expect(ring).toHaveLength(5);
    expect(ring[0]).toEqual(ring[4]);
    expect(signedArea2(ring)).toBeGreaterThan(0);
    const mPerDegLat = 111_195;
    const mPerDegLon = mPerDegLat * Math.cos((37.62 * Math.PI) / 180);
    const side = (a: Position, b: Position) => Math.hypot((b[0] - a[0]) * mPerDegLon, (b[1] - a[1]) * mPerDegLat);
    const [a, b, c] = ring as [Position, Position, Position];
    const lengths = [side(a, b), side(b, c)].sort((x, y) => x - y);
    expect(lengths[0]).toBeCloseTo(200 * 0.3048, 0);
    expect(lengths[1]).toBeCloseTo(11_870 * 0.3048, -2);
  });

  it('is empty for a zero-length runway or no width', () => {
    expect(runwayPolygon([0, 0], [0, 0], 100, 5)).toEqual([]);
    expect(runwayPolygon([0, 0], [0, 0.01], 0, 5)).toEqual([]);
  });
});

describe('CSV', () => {
  it('reads quoted fields with commas, quotes and newlines, CRLF, a BOM and a missing final newline', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"multi\nline",\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', '']]);
    expect(csvRecords('﻿id,name\n1,"San Carlos Airport"\n2')).toEqual([
      { id: '1', name: 'San Carlos Airport' },
      { id: '2', name: '' },
    ]);
    expect(csvNumber('')).toBeNull();
    expect(csvNumber('37.5')).toBe(37.5);
    expect(csvNumber('n/a')).toBeNull();
  });

  it('property: writing and reading back gives the same cells', () => {
    const cell = fc.string({ maxLength: 8 });
    fc.assert(
      fc.property(fc.array(fc.array(cell, { minLength: 2, maxLength: 2 }), { minLength: 1, maxLength: 6 }), (rows) => {
        const quote = (v: string) => `"${v.replaceAll('"', '""')}"`;
        const text = rows.map((r) => r.map(quote).join(',')).join('\n') + '\n';
        expect(parseCsv(text)).toEqual(rows);
      }),
    );
  });
});

describe('glyph ranges and output', () => {
  it('lists the 256-codepoint ranges the labels need, always with 0-255', () => {
    expect(glyphRanges(['SFO', 'Oakland'])).toEqual(['0-255']);
    expect(glyphRanges(['San José', 'Łódź'])).toEqual(['0-255', '256-511']);
    expect(glyphRanges([])).toEqual(['0-255']);
  });

  it('writes one feature per line and normalises -0', () => {
    expect(featureCollectionJson([{ a: 1 }, { b: 2 }])).toBe('{"type":"FeatureCollection","features":[\n{"a":1},\n{"b":2}\n]}\n');
    expect(Object.is(roundTo(-0.000001, 5), 0)).toBe(true);
  });
});

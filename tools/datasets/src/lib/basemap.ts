/*
 * Pure geometry and text helpers for the self-hosted basemap
 * (`src/basemap.ts`): clipping Natural Earth polygons to a box,
 * simplifying them, runway rectangles from OurAirports' runway ends, a
 * small RFC 4180 CSV reader, and the glyph ranges a set of labels needs.
 *
 * Everything here is deterministic: the same input gives the same
 * coordinates, in the same order, rounded the same way.
 */

/** A lon/lat box in WGS84 degrees (`west <= east`, no antimeridian crossing). */
export interface LonLatBox {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

export type Position = [lon: number, lat: number];
/** A closed ring: the first position is repeated at the end. */
export type Ring = Position[];
export type PolygonCoords = Ring[];

export function expandBox(box: LonLatBox, marginDeg: number): LonLatBox {
  return { west: box.west - marginDeg, south: box.south - marginDeg, east: box.east + marginDeg, north: box.north + marginDeg };
}

export function inBox(lon: number, lat: number, box: LonLatBox): boolean {
  return lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north;
}

/** Rounds to `decimals` places (5 ≈ 1 m), normalising -0 to 0. */
export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  const r = Math.round(value * f) / f;
  return r === 0 ? 0 : r;
}

type Edge = 'west' | 'east' | 'south' | 'north';
const EDGES: readonly Edge[] = ['west', 'east', 'south', 'north'];

function inside(p: Position, edge: Edge, box: LonLatBox): boolean {
  switch (edge) {
    case 'west':
      return p[0] >= box.west;
    case 'east':
      return p[0] <= box.east;
    case 'south':
      return p[1] >= box.south;
    case 'north':
      return p[1] <= box.north;
  }
}

function intersect(a: Position, b: Position, edge: Edge, box: LonLatBox): Position {
  if (edge === 'west' || edge === 'east') {
    const x = edge === 'west' ? box.west : box.east;
    const t = (x - a[0]) / (b[0] - a[0]);
    return [x, a[1] + (b[1] - a[1]) * t];
  }
  const y = edge === 'south' ? box.south : box.north;
  const t = (y - a[1]) / (b[1] - a[1]);
  return [a[0] + (b[0] - a[0]) * t, y];
}

/**
 * Sutherland–Hodgman clip of a closed ring to the box. Returns a closed ring,
 * or [] when nothing is left. A concave ring that leaves and re-enters the
 * box keeps zero-width connections along the box edge, which a fill renders
 * as nothing.
 */
export function clipRing(ring: readonly Position[], box: LonLatBox): Ring {
  // Work on the open ring.
  let points: Position[] = ring.length > 1 && samePosition(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : [...ring];
  for (const edge of EDGES) {
    if (points.length === 0) break;
    const input = points;
    points = [];
    for (let i = 0; i < input.length; i += 1) {
      const current = input[i] as Position;
      const previous = input[(i + input.length - 1) % input.length] as Position;
      const currentIn = inside(current, edge, box);
      const previousIn = inside(previous, edge, box);
      if (currentIn) {
        if (!previousIn) points.push(intersect(previous, current, edge, box));
        points.push(current);
      } else if (previousIn) {
        points.push(intersect(previous, current, edge, box));
      }
    }
  }
  if (points.length < 3) return [];
  return [...points, points[0] as Position];
}

function samePosition(a: Position | undefined, b: Position | undefined): boolean {
  return a !== undefined && b !== undefined && a[0] === b[0] && a[1] === b[1];
}

/** Twice the signed area (positive: counter-clockwise in lon/lat). */
export function signedArea2(ring: readonly Position[]): number {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i += 1) {
    const a = ring[i] as Position;
    const b = ring[i + 1] as Position;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}

function perpendicularDistance(p: Position, a: Position, b: Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length2 = dx * dx + dy * dy;
  if (length2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Douglas–Peucker on an open polyline (iterative, so long coastlines never overflow the stack). */
export function simplifyLine(points: readonly Position[], tolerance: number): Position[] {
  if (points.length <= 2 || tolerance <= 0) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop() as [number, number];
    let index = -1;
    let max = tolerance;
    for (let i = first + 1; i < last; i += 1) {
      const d = perpendicularDistance(points[i] as Position, points[first] as Position, points[last] as Position);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (index >= 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/**
 * Simplifies a closed ring (split at its two farthest-apart points so the
 * closure survives), rounds it and drops repeated positions. Returns [] when
 * it collapses below a triangle or below `minArea2` (twice the area, deg²).
 */
export function simplifyRing(ring: readonly Position[], tolerance: number, decimals: number, minArea2 = 0): Ring {
  const open = ring.length > 1 && samePosition(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : [...ring];
  if (open.length < 3) return [];
  // Split at the vertex farthest from the first one.
  let far = 0;
  let farDistance = -1;
  const origin = open[0] as Position;
  for (let i = 1; i < open.length; i += 1) {
    const p = open[i] as Position;
    const d = (p[0] - origin[0]) ** 2 + (p[1] - origin[1]) ** 2;
    if (d > farDistance) {
      farDistance = d;
      far = i;
    }
  }
  const firstHalf = simplifyLine(open.slice(0, far + 1), tolerance);
  const secondHalf = simplifyLine([...open.slice(far), origin], tolerance);
  const merged = [...firstHalf, ...secondHalf.slice(1)];
  const rounded: Position[] = [];
  for (const [lon, lat] of merged) {
    const p: Position = [roundTo(lon, decimals), roundTo(lat, decimals)];
    if (!samePosition(rounded[rounded.length - 1], p)) rounded.push(p);
  }
  // `merged` ends at `origin`, so the rounded ring is closed; a triangle needs 4 positions.
  if (rounded.length < 4) return [];
  if (Math.abs(signedArea2(rounded)) <= minArea2) return [];
  return rounded;
}

export interface ClipOptions {
  readonly box: LonLatBox;
  /** Douglas–Peucker tolerance in degrees. */
  readonly tolerance: number;
  readonly decimals: number;
  /** Rings with twice their area at or below this (deg²) are dropped. */
  readonly minArea2?: number;
}

/**
 * Clips (Multi)Polygon coordinates to the box and simplifies them. Holes
 * whose outer ring is gone go with it. Returns the polygons left, in input
 * order.
 */
export function clipPolygons(polygons: readonly (readonly (readonly Position[])[])[], options: ClipOptions): PolygonCoords[] {
  const out: PolygonCoords[] = [];
  for (const polygon of polygons) {
    const [outer, ...holes] = polygon;
    if (!outer || !ringTouchesBox(outer, options.box)) continue;
    const clippedOuter = simplifyRing(clipRing(outer, options.box), options.tolerance, options.decimals, options.minArea2 ?? 0);
    if (clippedOuter.length === 0) continue;
    const kept: Ring[] = [clippedOuter];
    for (const hole of holes) {
      if (!ringTouchesBox(hole, options.box)) continue;
      const clippedHole = simplifyRing(clipRing(hole, options.box), options.tolerance, options.decimals, options.minArea2 ?? 0);
      if (clippedHole.length > 0) kept.push(clippedHole);
    }
    out.push(kept);
  }
  return out;
}

function ringTouchesBox(ring: readonly Position[], box: LonLatBox): boolean {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return west <= box.east && east >= box.west && south <= box.north && north >= box.south;
}

/** (Multi)Polygon geometry → a list of polygons; anything else → []. */
export function polygonsOf(geometry: unknown): Position[][][] {
  if (!geometry || typeof geometry !== 'object') return [];
  const g = geometry as { type?: unknown; coordinates?: unknown };
  if (g.type === 'Polygon') return [g.coordinates as Position[][]];
  if (g.type === 'MultiPolygon') return g.coordinates as Position[][][];
  return [];
}

// --- Runways --------------------------------------------------------------------

const EARTH_RADIUS_M = 6_371_008.8;
const FT_TO_M = 0.3048;

/**
 * The runway as a rectangle: the centreline between its two ends, widened by
 * `widthFt` (local equirectangular projection around the midpoint, exact to
 * centimetres at runway scale). Counter-clockwise, closed, rounded.
 */
export function runwayPolygon(le: Position, he: Position, widthFt: number, decimals: number): Ring {
  const midLat = ((le[1] + he[1]) / 2) * (Math.PI / 180);
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLon = mPerDegLat * Math.cos(midLat);
  const dx = (he[0] - le[0]) * mPerDegLon;
  const dy = (he[1] - le[1]) * mPerDegLat;
  const length = Math.hypot(dx, dy);
  if (!(length > 0) || !(widthFt > 0)) return [];
  const half = (widthFt * FT_TO_M) / 2;
  // Left normal of le → he.
  const nx = (-dy / length) * half;
  const ny = (dx / length) * half;
  const offset = (p: Position, sx: number, sy: number): Position => [roundTo(p[0] + sx / mPerDegLon, decimals), roundTo(p[1] + sy / mPerDegLat, decimals)];
  const ring: Ring = [offset(le, -nx, -ny), offset(he, -nx, -ny), offset(he, nx, ny), offset(le, nx, ny)];
  ring.push(ring[0] as Position);
  return signedArea2(ring) < 0 ? ring.reverse() : ring;
}

// --- CSV --------------------------------------------------------------------------

/** RFC 4180 rows: quoted fields may hold commas, quotes ("") and newlines. CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i += 1;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += c;
      i += 1;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** CSV text with a header row → one record per data row (missing cells are ''). */
export function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!header) return [];
  return rows
    .filter((row) => !(row.length === 1 && row[0] === ''))
    .map((row) => Object.fromEntries(header.map((name, index) => [name, row[index] ?? ''])));
}

/** A finite number from a CSV cell, or null for '' and junk. */
export function csvNumber(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// --- Glyphs ------------------------------------------------------------------------

/**
 * The 256-codepoint glyph ranges (`"0-255"`, `"256-511"`, …) that the given
 * label texts need, ascending. MapLibre fetches `{range}.pbf` per range.
 */
export function glyphRanges(texts: Iterable<string>): string[] {
  const starts = new Set<number>([0]);
  for (const text of texts) {
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp > 0xffff) continue; // MapLibre's glyph PBFs cover the BMP only.
      starts.add(Math.floor(cp / 256) * 256);
    }
  }
  return [...starts].sort((a, b) => a - b).map((start) => `${start}-${start + 255}`);
}

/** Stable JSON for committed files: keys in insertion order, numbers as JS prints them, one feature per line. */
export function featureCollectionJson(features: readonly unknown[]): string {
  if (features.length === 0) return '{"type":"FeatureCollection","features":[]}\n';
  return `{"type":"FeatureCollection","features":[\n${features.map((feature) => JSON.stringify(feature)).join(',\n')}\n]}\n`;
}

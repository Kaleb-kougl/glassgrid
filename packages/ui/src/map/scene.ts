import { altitudeClass, altitudeFt, altitudePalette, classColor, type AltitudeClass, type AltitudePalette } from './altitude.js';
import {
  clockElapsed,
  easeOffset,
  isEasing,
  placementAt,
  startClock,
  updateClock,
  type EaseOffset,
  type Fix,
  type Placement,
  type PlaybackClock,
} from './dead-reckoning.js';
import { mercatorX, mercatorY, ORIGIN_X, ORIGIN_Y } from './mercator.js';
import type { MapAircraft, MapTrailPoint } from './types.js';
import type { ThemeName } from '../tokens.js';

/*
 * The aircraft layer's state without WebGL: the current fixes with their
 * ease offsets, the playback clock, and the vertex data the layer uploads.
 * Pure TypeScript, so the geometry is unit-tested (scene.test.ts).
 *
 * Vertex layouts (interleaved, 32 bytes per vertex, little-endian floats):
 *
 * - glyphs, 4 vertices per aircraft (indexed): position (2 × f32, Mercator
 *   relative to ORIGIN), corner (2 × f32, −1..1), angle (f32, radians
 *   clockwise from screen-up), radius (f32, CSS px), kind (f32: 0 plane,
 *   1 ring; +2 when selected), colour (4 × u8);
 * - trails and connectors, 4 vertices per segment (indexed): end A (2 × f32),
 *   end B (2 × f32), side (f32, ±1), which end (f32, 0 or 1), time of that
 *   end (f32, seconds after the scene's base time), colour (4 × u8, alpha =
 *   opacity at age 0).
 */

export const VERTEX_BYTES = 32;
export const VERTEX_FLOATS = VERTEX_BYTES / 4;
/** CSS px radius of the glyph quads. */
export const PLANE_RADIUS = 11;
export const PLANE_RADIUS_SELECTED = 14;
export const RING_RADIUS = 9;
export const RING_RADIUS_SELECTED = 12;
/** Trails: the window they fade over, the thinning step and the gap that breaks a line. */
export const TRAIL_WINDOW_MS = 5 * 60_000;
export const TRAIL_MIN_STEP_MS = 8_000;
/** …but a turn sharper than TRAIL_TURN_DEG keeps a point after TRAIL_TURN_MIN_MS, so curves stay round at high zoom. */
export const TRAIL_TURN_DEG = 10;
export const TRAIL_TURN_MIN_MS = 2_000;
export const TRAIL_MAX_GAP_MS = 60_000;
export const TRAIL_ALPHA = 0.7;
export const TRAIL_ALPHA_SELECTED = 1;
/**
 * The selected aircraft's track (L4, `selectedTrack`): thinned like a trail
 * but over its whole length, never faded, broken where its fixes are more
 * than TRACK_MAX_GAP_MS apart (an aircraft that left coverage, or landed and
 * flew again hours later, is not joined by a straight line), at most
 * MAX_TRACK_POINTS of it used (the newest).
 */
export const TRACK_MAX_GAP_MS = 5 * 60_000;
export const MAX_TRACK_POINTS = 5_000;

interface Entry {
  readonly hex: string;
  readonly fix: Fix;
  readonly flight: string | null;
  readonly cls: AltitudeClass;
  /** Draw order key: ground first, then by altitude, so higher traffic is on top. */
  readonly order: number;
  offset: EaseOffset | null;
}

export interface ScenePlacement extends Placement {
  readonly hex: string;
  readonly flight: string | null;
}

export interface VertexData {
  /** Interleaved vertices (VERTEX_BYTES each). */
  readonly vertices: ArrayBuffer;
  readonly floats: Float32Array;
  readonly bytes: Uint8Array;
  /** Indices into `vertices`, 6 per quad. */
  readonly indices: Uint32Array;
  readonly quads: number;
}

function allocate(quads: number, previous?: VertexData | null): VertexData {
  if (previous && previous.vertices.byteLength >= quads * 4 * VERTEX_BYTES && previous.indices.length >= quads * 6) return { ...previous, quads };
  const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(Math.max(1, quads))));
  const vertices = new ArrayBuffer(capacity * 4 * VERTEX_BYTES);
  const indices = new Uint32Array(capacity * 6);
  for (let q = 0; q < capacity; q += 1) {
    const v = q * 4;
    indices.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], q * 6);
  }
  return { vertices, floats: new Float32Array(vertices), bytes: new Uint8Array(vertices), indices, quads };
}

function writeColor(bytes: Uint8Array, vertex: number, rgb: readonly [number, number, number], alpha: number): void {
  const o = vertex * VERTEX_BYTES + 28;
  bytes[o] = rgb[0];
  bytes[o + 1] = rgb[1];
  bytes[o + 2] = rgb[2];
  bytes[o + 3] = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
}

const SIDES = [-1, 1, -1, 1] as const;
const ENDS = [0, 0, 1, 1] as const;
const CORNERS = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

/** Writes one trail segment (4 vertices) at quad `q`. */
function writeSegment(data: VertexData, q: number, ax: number, ay: number, ta: number, ca: readonly [number, number, number], bx: number, by: number, tb: number, cb: readonly [number, number, number], alpha: number): void {
  const { floats, bytes } = data;
  for (let k = 0; k < 4; k += 1) {
    const v = q * 4 + k;
    const f = v * VERTEX_FLOATS;
    floats[f] = ax;
    floats[f + 1] = ay;
    floats[f + 2] = bx;
    floats[f + 3] = by;
    floats[f + 4] = SIDES[k] as number;
    floats[f + 5] = ENDS[k] as number;
    floats[f + 6] = ENDS[k] === 0 ? ta : tb;
    writeColor(bytes, v, ENDS[k] === 0 ? ca : cb, alpha);
  }
}

function fixOf(a: MapAircraft): Fix {
  return { lat: a.lat, lon: a.lon, gsKt: a.gsKt, trackDeg: a.trackDeg, onGround: a.onGround, ts: a.ts };
}

/** The latest trail point kept per aircraft, for the connector to the drawn position. */
interface TrailTail {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

export class AircraftScene {
  private entries: Entry[] = [];
  private byHex = new Map<string, Entry>();
  private trailsInput: readonly MapTrailPoint[] = [];
  private tails = new Map<string, TrailTail>();
  private clock: PlaybackClock;
  private dataClockMs = 0;
  /** Data time (epoch ms) that trail and connector times count from. */
  private baseMs = 0;
  private selected: string | null = null;
  private palette: AltitudePalette;
  private glyphData: VertexData | null = null;
  private connectorData: VertexData | null = null;
  private trailData: VertexData | null = null;
  /** Bumped whenever `trails()` returns new geometry. */
  trailVersion = 0;
  private trailDirty = true;
  private trackInput: readonly MapTrailPoint[] = [];
  private trackData: VertexData | null = null;
  /** Bumped whenever `track()` returns new geometry. */
  trackVersion = 0;
  private trackDirty = true;

  constructor(theme: ThemeName = 'light', now = 0) {
    this.palette = altitudePalette(theme);
    this.clock = startClock(now, false, 1);
  }

  get count(): number {
    return this.entries.length;
  }

  get selectedHex(): string | null {
    return this.selected;
  }

  /**
   * New rows. Each aircraft that was already drawn eases from where it is
   * drawn now to its new extrapolated position; the playback clock
   * restarts (wall time counts from `now`).
   */
  setData(aircraft: readonly MapAircraft[], trails: readonly MapTrailPoint[], dataClockMs: number, now: number): void {
    const drawn = new Map<string, Placement>();
    for (const p of this.placements(now)) drawn.set(p.hex, p);
    this.clock = startClock(now, this.clock.playing, this.clock.speed);
    this.dataClockMs = Number.isFinite(dataClockMs) ? dataClockMs : 0;
    this.baseMs = this.dataClockMs;
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const a of aircraft) {
      if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon) || seen.has(a.hex)) continue;
      seen.add(a.hex);
      const fix = fixOf(a);
      const alt = altitudeFt(a);
      const cls = altitudeClass(alt, a.onGround);
      const order = cls === 'ground' ? -2e6 : cls === 'unknown' ? -1e6 : (alt ?? 0);
      const entry: Entry = { hex: a.hex, fix, flight: a.flight, cls, order, offset: null };
      entry.offset = easeOffset(drawn.get(a.hex), placementAt(fix, null, this.dataClockMs, this.clock, now), now);
      entries.push(entry);
    }
    entries.sort((a, b) => a.order - b.order || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0));
    this.entries = entries;
    this.byHex = new Map(entries.map((e) => [e.hex, e]));
    this.trailsInput = trails;
    this.trailDirty = true;
  }

  /** The selected aircraft's track (sorted by ts or not); only its points of the selected aircraft are drawn. */
  setTrack(points: readonly MapTrailPoint[] | null | undefined): void {
    const next = points ?? NO_TRACK;
    if (next === this.trackInput) return;
    this.trackInput = next;
    this.trackDirty = true;
  }

  setPlayback(playing: boolean, speed: number | undefined, now: number): void {
    this.clock = updateClock(this.clock, now, playing, speed);
  }

  setSelected(hex: string | null | undefined): void {
    const next = hex ?? null;
    if (next === this.selected) return;
    this.selected = next;
    this.trailDirty = true;
    this.trackDirty = true;
  }

  setTheme(theme: ThemeName): void {
    const palette = altitudePalette(theme);
    if (palette === this.palette) return;
    this.palette = palette;
    this.trailDirty = true;
    this.trackDirty = true;
  }

  get outline(): readonly [number, number, number] {
    return this.palette.outline;
  }

  get selection(): readonly [number, number, number] {
    return this.palette.selection;
  }

  /** True while drawn positions change on their own: playing, or an ease still running. */
  isAnimating(now: number): boolean {
    if (this.clock.playing && this.clock.speed > 0 && this.entries.length > 0) return true;
    return this.entries.some((e) => isEasing(e.offset, now));
  }

  /** Data time now (epoch ms): the data clock plus the scaled wall time since the rows arrived. */
  dataTimeAt(now: number): number {
    return this.dataClockMs + clockElapsed(this.clock, now);
  }

  /** Seconds after the base time, for the trail fade (`u_now`). */
  trailTimeAt(now: number): number {
    return (this.dataTimeAt(now) - this.baseMs) / 1000;
  }

  /** Where each aircraft is drawn at `now`, in draw order (the selected one last). */
  placements(now: number): ScenePlacement[] {
    const out: ScenePlacement[] = [];
    let selected: ScenePlacement | null = null;
    for (const e of this.entries) {
      const p = placementAt(e.fix, e.offset, this.dataClockMs, this.clock, now);
      const placement = { hex: e.hex, flight: e.flight, lat: p.lat, lon: p.lon, trackDeg: p.trackDeg };
      if (e.hex === this.selected) selected = placement;
      else out.push(placement);
    }
    if (selected) out.push(selected);
    return out;
  }

  /** Glyph quads for `now` (map bearing in degrees, so glyphs point along their track on screen). */
  glyphs(now: number, bearingDeg = 0): VertexData {
    const placements = this.placements(now);
    const data = allocate(placements.length, this.glyphData);
    this.glyphData = data;
    const { floats, bytes } = data;
    placements.forEach((p, q) => {
      const e = this.byHex.get(p.hex) as Entry;
      const selected = p.hex === this.selected;
      const ring = e.cls === 'ground';
      const radius = ring ? (selected ? RING_RADIUS_SELECTED : RING_RADIUS) : selected ? PLANE_RADIUS_SELECTED : PLANE_RADIUS;
      const angle = (((p.trackDeg ?? 0) - bearingDeg) * Math.PI) / 180;
      const x = mercatorX(p.lon) - ORIGIN_X;
      const y = mercatorY(p.lat) - ORIGIN_Y;
      const kind = (ring ? 1 : 0) + (selected ? 2 : 0);
      const color = classColor(this.palette, e.cls);
      for (let k = 0; k < 4; k += 1) {
        const v = q * 4 + k;
        const f = v * VERTEX_FLOATS;
        const corner = CORNERS[k] as readonly [number, number];
        floats[f] = x;
        floats[f + 1] = y;
        floats[f + 2] = corner[0];
        floats[f + 3] = corner[1];
        floats[f + 4] = angle;
        floats[f + 5] = radius;
        floats[f + 6] = kind;
        writeColor(bytes, v, color, 1);
      }
    });
    return data;
  }

  /** Segments from each trail's last kept point to where its aircraft is drawn now. */
  connectors(now: number): VertexData {
    this.ensureTrails();
    const placements = this.placements(now);
    const data = allocate(placements.length, this.connectorData);
    this.connectorData = data;
    const t = this.trailTimeAt(now);
    let q = 0;
    for (const p of placements) {
      const tail = this.tails.get(p.hex);
      if (!tail) continue;
      const e = this.byHex.get(p.hex) as Entry;
      const color = classColor(this.palette, e.cls);
      const alpha = p.hex === this.selected ? TRAIL_ALPHA_SELECTED : TRAIL_ALPHA;
      writeSegment(data, q, tail.x, tail.y, tail.t, color, mercatorX(p.lon) - ORIGIN_X, mercatorY(p.lat) - ORIGIN_Y, t, color, alpha);
      q += 1;
    }
    return { ...data, quads: q };
  }

  /** The trail segments (rebuilt only when rows, the selection or the theme change; see `trailVersion`). */
  trails(): VertexData {
    this.ensureTrails();
    return this.trailData ?? allocate(0);
  }

  /**
   * The selected aircraft's track as solid segments in the selection colour
   * (rebuilt only when the track, the selection or the theme change; see
   * `trackVersion`). Times are written as the scene's base time, so the
   * trail shader's fade (given a window it never reaches) leaves it opaque.
   */
  track(): VertexData {
    this.ensureTrack();
    return this.trackData ?? allocate(0);
  }

  /** Points of the selected aircraft's track that are drawn, after thinning (for tests and the benchmark). */
  trackPoints(): { x: number; y: number; ts: number }[] {
    const selected = this.selected;
    if (selected === null) return [];
    let points = this.trackInput.filter((p) => p.hex === selected && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Number.isFinite(p.ts));
    if (!isSortedTrack(points)) points = [...points].sort((a, b) => a.ts - b.ts);
    if (points.length > MAX_TRACK_POINTS) points = points.slice(points.length - MAX_TRACK_POINTS);
    return thinLine(points, -Infinity).map((p) => ({ x: p.x, y: p.y, ts: p.ts }));
  }

  private ensureTrack(): void {
    if (!this.trackDirty) return;
    this.trackDirty = false;
    this.trackVersion += 1;
    const kept = this.trackPoints();
    let segments = 0;
    for (let k = 0; k + 1 < kept.length; k += 1) if ((kept[k + 1] as (typeof kept)[number]).ts - (kept[k] as (typeof kept)[number]).ts <= TRACK_MAX_GAP_MS) segments += 1;
    const data = allocate(segments, this.trackData);
    const color = this.palette.selection;
    let q = 0;
    for (let k = 0; k + 1 < kept.length; k += 1) {
      const a = kept[k] as (typeof kept)[number];
      const b = kept[k + 1] as (typeof kept)[number];
      if (b.ts - a.ts > TRACK_MAX_GAP_MS) continue;
      writeSegment(data, q, a.x, a.y, 0, color, b.x, b.y, 0, color, 1);
      q += 1;
    }
    this.trackData = { ...data, quads: q };
  }

  private ensureTrails(): void {
    if (!this.trailDirty) return;
    this.trailDirty = false;
    this.trailVersion += 1;
    const points = isSortedTrail(this.trailsInput) ? this.trailsInput : [...this.trailsInput].sort((a, b) => (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : a.ts - b.ts));
    const since = this.dataClockMs - TRAIL_WINDOW_MS;
    // Thin each aircraft's trail to one point per TRAIL_MIN_STEP_MS, or sooner in a turn (always keeping its last point).
    const kept: { hex: string; x: number; y: number; t: number; cls: AltitudeClass }[] = [];
    let i = 0;
    while (i < points.length) {
      const hex = (points[i] as MapTrailPoint).hex;
      let j = i;
      while (j < points.length && (points[j] as MapTrailPoint).hex === hex) j += 1;
      if (this.byHex.has(hex)) {
        let lastTs = -Infinity;
        let keptHere = 0;
        let lastX = 0;
        let lastY = 0;
        /** Direction of the last kept segment (radians), or null before the second point. */
        let heading: number | null = null;
        for (let k = i; k < j; k += 1) {
          const p = points[k] as MapTrailPoint;
          if (p.ts < since || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || !Number.isFinite(p.ts)) continue;
          const isLast = k === j - 1;
          const x = mercatorX(p.lon) - ORIGIN_X;
          const y = mercatorY(p.lat) - ORIGIN_Y;
          const dt = p.ts - lastTs;
          const direction = keptHere > 0 && (x !== lastX || y !== lastY) ? Math.atan2(y - lastY, x - lastX) : null;
          const turning = heading !== null && direction !== null && dt >= TRAIL_TURN_MIN_MS && Math.abs(Math.atan2(Math.sin(direction - heading), Math.cos(direction - heading))) > (TRAIL_TURN_DEG * Math.PI) / 180;
          const due = dt >= TRAIL_MIN_STEP_MS || turning;
          if (!due && !isLast) continue;
          // The last point replaces a kept one that is too close to it, unless that one starts the trail.
          if (!due && keptHere >= 2) {
            kept.pop();
            keptHere -= 1;
          }
          kept.push({ hex, x, y, t: (p.ts - this.baseMs) / 1000, cls: altitudeClass(altitudeFt(p), false) });
          // Across a gap there is no line, so no direction to compare the next one with.
          if (due) heading = dt > TRAIL_MAX_GAP_MS ? null : (direction ?? heading);
          keptHere += 1;
          lastTs = p.ts;
          lastX = x;
          lastY = y;
        }
      }
      i = j;
    }
    const tails = new Map<string, TrailTail>();
    let segments = 0;
    for (let k = 0; k + 1 < kept.length; k += 1) if (kept[k]?.hex === kept[k + 1]?.hex) segments += 1;
    const data = allocate(segments, this.trailData);
    let q = 0;
    for (let k = 0; k < kept.length; k += 1) {
      const a = kept[k] as (typeof kept)[number];
      const b = kept[k + 1];
      if (!b || b.hex !== a.hex) {
        tails.set(a.hex, { x: a.x, y: a.y, t: a.t });
        continue;
      }
      if ((b.t - a.t) * 1000 > TRAIL_MAX_GAP_MS) continue;
      const alpha = a.hex === this.selected ? TRAIL_ALPHA_SELECTED : TRAIL_ALPHA;
      writeSegment(data, q, a.x, a.y, a.t, classColor(this.palette, a.cls), b.x, b.y, b.t, classColor(this.palette, b.cls), alpha);
      q += 1;
    }
    this.trailData = { ...data, quads: q };
    this.tails = tails;
  }
}

const NO_TRACK: readonly MapTrailPoint[] = Object.freeze([]);

function isSortedTrack(points: readonly MapTrailPoint[]): boolean {
  for (let i = 1; i < points.length; i += 1) if ((points[i - 1] as MapTrailPoint).ts > (points[i] as MapTrailPoint).ts) return false;
  return true;
}

/**
 * One aircraft's points (sorted by ts) thinned as trails are: one per
 * TRAIL_MIN_STEP_MS, or sooner where the line turns by more than
 * TRAIL_TURN_DEG (after TRAIL_TURN_MIN_MS), always keeping the first and the
 * last point. Points before `since` are dropped. Mercator x/y relative to
 * ORIGIN.
 */
function thinLine(points: readonly MapTrailPoint[], since: number): { x: number; y: number; ts: number; p: MapTrailPoint }[] {
  const kept: { x: number; y: number; ts: number; p: MapTrailPoint }[] = [];
  let lastTs = -Infinity;
  let lastX = 0;
  let lastY = 0;
  let heading: number | null = null;
  for (let k = 0; k < points.length; k += 1) {
    const p = points[k] as MapTrailPoint;
    if (p.ts < since) continue;
    const isLast = k === points.length - 1;
    const x = mercatorX(p.lon) - ORIGIN_X;
    const y = mercatorY(p.lat) - ORIGIN_Y;
    const dt = p.ts - lastTs;
    const direction = kept.length > 0 && (x !== lastX || y !== lastY) ? Math.atan2(y - lastY, x - lastX) : null;
    const turning = heading !== null && direction !== null && dt >= TRAIL_TURN_MIN_MS && Math.abs(Math.atan2(Math.sin(direction - heading), Math.cos(direction - heading))) > (TRAIL_TURN_DEG * Math.PI) / 180;
    const due = dt >= TRAIL_MIN_STEP_MS || turning;
    if (!due && !isLast) continue;
    if (!due && kept.length >= 2) kept.pop();
    kept.push({ x, y, ts: p.ts, p });
    if (due) heading = dt > TRACK_MAX_GAP_MS ? null : (direction ?? heading);
    lastTs = p.ts;
    lastX = x;
    lastY = y;
  }
  return kept;
}

function isSortedTrail(points: readonly MapTrailPoint[]): boolean {
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1] as MapTrailPoint;
    const b = points[i] as MapTrailPoint;
    if (a.hex > b.hex || (a.hex === b.hex && a.ts > b.ts)) return false;
  }
  return true;
}

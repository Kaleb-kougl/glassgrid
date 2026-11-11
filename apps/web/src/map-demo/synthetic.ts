import type { MapAircraft, MapTrailPoint } from '@glassgrid/ui/map';

/*
 * Deterministic synthetic Bay Area traffic for the map test page and its
 * benchmark: N aircraft (183 by default, the fixtures' measured peak in
 * view), about a third on the ground at SFO, OAK, SJC and San Carlos, the
 * rest flying constant-rate turns at altitudes across every band. Each
 * aircraft's position is a closed-form function of time, so a "poll" at any
 * data time gives its fix and a 5-minute trail at a 2 s cadence (the
 * fixtures' median fix interval). No real data: nothing to license.
 *
 * One aircraft, `test01` ("TEST01"), sits still at `TEST_POSITION` (3,000 ft,
 * zero ground speed): the E2E clicks it to check selection.
 */

export const TEST_HEX = 'test01';
export const TEST_POSITION = { lon: -122.25, lat: 37.62 } as const;
/** The fixtures' busiest moment (2026-11-09 23:27:30 UTC), as the demo's data clock start. */
export const DEMO_START_MS = Date.UTC(2026, 10, 9, 23, 27, 30);
export const TRAIL_STEP_MS = 2_000;
export const TRAIL_WINDOW_MS = 5 * 60_000;

const AIRPORTS = [
  { lon: -122.3748, lat: 37.6198, weight: 5 }, // SFO
  { lon: -122.2212, lat: 37.7201, weight: 3 }, // OAK
  { lon: -121.9292, lat: 37.3625, weight: 3 }, // SJC
  { lon: -122.2508, lat: 37.5131, weight: 1 }, // KSQL
];
const TYPES = ['B738', 'A320', 'A321', 'B77W', 'E75L', 'B789', 'C172', 'PC12', 'A21N', 'B38M'];
const AIRLINES = ['UAL', 'SWA', 'ASA', 'DAL', 'AAL', 'SKW', 'JBU', 'N'];
const M_PER_DEG = 111_320;
const KT = 1852 / 3600;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Track {
  readonly hex: string;
  readonly flight: string | null;
  readonly typeCode: string;
  readonly onGround: boolean;
  readonly lon0: number;
  readonly lat0: number;
  readonly altFt: number;
  readonly climbFpm: number;
  readonly gsKt: number;
  readonly track0: number;
  /** Degrees per second (0: straight). */
  readonly turn: number;
}

function makeTracks(n: number, seed: number): Track[] {
  const rand = mulberry32(seed);
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)] as T;
  const totalWeight = AIRPORTS.reduce((s, a) => s + a.weight, 0);
  const airport = () => {
    let r = rand() * totalWeight;
    for (const a of AIRPORTS) {
      r -= a.weight;
      if (r <= 0) return a;
    }
    return AIRPORTS[0] as (typeof AIRPORTS)[number];
  };
  const tracks: Track[] = [{ hex: TEST_HEX, flight: 'TEST01', typeCode: 'B738', onGround: false, lon0: TEST_POSITION.lon, lat0: TEST_POSITION.lat, altFt: 3_000, climbFpm: 0, gsKt: 0, track0: 45, turn: 0 }];
  for (let i = 1; i < n; i += 1) {
    const hex = (0xa00000 + Math.floor(rand() * 0x0fffff)).toString(16);
    const airline = pick(AIRLINES);
    const flight = airline === 'N' ? `N${100 + Math.floor(rand() * 899)}${String.fromCharCode(65 + Math.floor(rand() * 26))}` : `${airline}${1 + Math.floor(rand() * 2999)}`;
    if (rand() < 0.33) {
      const a = airport();
      tracks.push({ hex, flight, typeCode: pick(TYPES), onGround: true, lon0: a.lon + (rand() - 0.5) * 0.02, lat0: a.lat + (rand() - 0.5) * 0.016, altFt: 0, climbFpm: 0, gsKt: rand() < 0.6 ? 0 : 5 + rand() * 20, track0: rand() * 360, turn: (rand() - 0.5) * 2 });
      continue;
    }
    // Altitude: log-uniform-ish from 500 ft to 40,000 ft, so every band is populated.
    const altFt = Math.round(500 * Math.exp(rand() * Math.log(80)));
    const gsKt = Math.min(520, 110 + altFt * 0.011 + rand() * 60);
    tracks.push({
      hex,
      flight: rand() < 0.03 ? null : flight,
      typeCode: pick(TYPES),
      onGround: false,
      lon0: -123.0 + rand() * 1.5,
      lat0: 37.0 + rand() * 1.5,
      altFt,
      climbFpm: altFt < 12_000 ? Math.round((rand() - 0.5) * 3_000) : 0,
      gsKt,
      track0: rand() * 360,
      // Every airborne track turns (0.15–0.45 °/s either way), so traffic circles over the Bay instead of leaving it.
      turn: (rand() < 0.5 ? -1 : 1) * (0.15 + rand() * 0.3),
    });
  }
  return tracks;
}

/** Position of a track `seconds` after the demo start (constant-rate turn, closed form). */
function positionAt(t: Track, seconds: number): { lon: number; lat: number; track: number; alt: number } {
  const v = t.gsKt * KT;
  const h0 = (t.track0 * Math.PI) / 180;
  let east: number;
  let north: number;
  let track: number;
  if (Math.abs(t.turn) < 1e-9) {
    east = v * seconds * Math.sin(h0);
    north = v * seconds * Math.cos(h0);
    track = t.track0;
  } else {
    const w = (t.turn * Math.PI) / 180;
    const h = h0 + w * seconds;
    east = (v / w) * (Math.cos(h0) - Math.cos(h));
    north = (v / w) * (Math.sin(h) - Math.sin(h0));
    track = (((h * 180) / Math.PI) % 360 + 360) % 360;
  }
  const lat = t.lat0 + north / M_PER_DEG;
  const lon = t.lon0 + east / (M_PER_DEG * Math.cos((t.lat0 * Math.PI) / 180));
  const alt = Math.max(200, t.altFt + (t.climbFpm * ((seconds % 240) - 120)) / 60);
  return { lon, lat, track, alt };
}

export interface Snapshot {
  readonly aircraft: MapAircraft[];
  readonly trails: MapTrailPoint[];
  readonly dataClockMs: number;
}

export class SyntheticTraffic {
  private readonly tracks: Track[];
  private readonly jitter: number[];

  constructor(n = 183, seed = 20261109) {
    this.tracks = makeTracks(Math.max(1, n), seed);
    const rand = mulberry32(seed ^ 0x5eed);
    this.jitter = this.tracks.map(() => Math.floor(rand() * 8_000));
  }

  get size(): number {
    return this.tracks.length;
  }

  /** What a poll at data time `dataClockMs` returns: the latest fix per aircraft and 5 minutes of trail. */
  snapshot(dataClockMs: number): Snapshot {
    const aircraft: MapAircraft[] = [];
    const trails: MapTrailPoint[] = [];
    const sorted = this.tracks.map((t, i) => ({ t, i })).sort((a, b) => (a.t.hex < b.t.hex ? -1 : a.t.hex > b.t.hex ? 1 : 0));
    for (const { t, i } of sorted) {
      const ts = dataClockMs - (t.hex === TEST_HEX ? 0 : (this.jitter[i] ?? 0));
      const p = positionAt(t, (ts - DEMO_START_MS) / 1000);
      aircraft.push({
        hex: t.hex,
        flight: t.flight,
        typeCode: t.typeCode,
        category: t.typeCode === 'C172' ? 'A1' : 'A3',
        lat: p.lat,
        lon: p.lon,
        altBaroFt: t.onGround ? null : Math.round(p.alt / 25) * 25,
        altGeomFt: t.onGround ? null : Math.round((p.alt + 150) / 25) * 25,
        onGround: t.onGround,
        gsKt: Math.round(t.gsKt * 10) / 10,
        trackDeg: Math.round(p.track * 10) / 10,
        baroRateFpm: t.onGround ? null : t.climbFpm,
        ts,
      });
      const first = Math.ceil((ts - TRAIL_WINDOW_MS) / TRAIL_STEP_MS) * TRAIL_STEP_MS;
      for (let at = first; at <= ts; at += TRAIL_STEP_MS) {
        const q = positionAt(t, (at - DEMO_START_MS) / 1000);
        trails.push({ hex: t.hex, ts: at, lat: q.lat, lon: q.lon, altBaroFt: t.onGround ? null : Math.round(q.alt / 25) * 25 });
      }
    }
    return { aircraft, trails, dataClockMs };
  }
}

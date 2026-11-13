import { describe, expect, it } from 'vitest';
import { BAY_AREA_BBOX, bboxCenter, bboxCoverRadiusNm, distanceNm, FlightBboxSchema, inBbox } from './bbox.js';
import { FLIGHT_POINT_FIELDS, FlightPointSchema, type FlightPoint } from './point.js';
import { fromReadsbAircraft, fromTrace, fromTracePoint, normalizeHex, parseReadsbResponse, readsbNowSeconds } from './readsb.js';

/*
 * The adapters against the examples in readsb's README-json.md: the trace
 * example (D-AIUP / DLH7YA over Bavaria) and aircraft.json keys, plus the
 * Bay Area box the fixtures use.
 */

/** The trace example from README-json.md ("trace jsons"), first two points. */
const README_TRACE = {
  icao: '3c66b0',
  r: 'D-AIUP',
  t: 'A320',
  dbFlags: 0,
  desc: 'AIRBUS A-320',
  timestamp: 1663259853.016,
  trace: [
    [
      7016.59, 49.2633, 10.614239, 25125, 446.5, 309.0, 0, -2176,
      { type: 'adsb_icao', flight: 'DLH7YA  ', alt_geom: 25875, track: 309.0, baro_rate: -2176, geom_rate: -2208, squawk: '1000', category: 'A3' },
      'adsb_icao', 25875, -2208, 335, -10.7,
    ],
    [7024.85, 49.273589, 10.593278, 24825, 446.0, 306.6, 0, -2176, null, 'adsb_icao', 25550, -2144, 337, -1.6],
  ],
};

const SFO = { lat: 37.6189, lon: -122.375 };

describe('FlightPointSchema', () => {
  it('lists its fields in FLIGHT_POINT_FIELDS, in a fixed order', () => {
    expect([...FLIGHT_POINT_FIELDS].sort()).toEqual(Object.keys(FlightPointSchema.shape).sort());
  });
});

describe('Bay Area box', () => {
  it('covers SFO, OAK, SJC and San Carlos, but not Sacramento or Monterey', () => {
    for (const [lat, lon] of [
      [SFO.lat, SFO.lon],
      [37.7213, -122.2208], // OAK
      [37.3626, -121.929], // SJC
      [37.5119, -122.2495], // KSQL
    ] as const) {
      expect(inBbox(lat, lon)).toBe(true);
    }
    expect(inBbox(38.6954, -121.5908)).toBe(false); // SMF
    expect(inBbox(36.587, -121.843)).toBe(false); // MRY
    expect(FlightBboxSchema.safeParse(BAY_AREA_BBOX).success).toBe(true);
  });

  it('includes its edges and rejects NaN', () => {
    expect(inBbox(37.0, -123.0)).toBe(true);
    expect(inBbox(38.5, -121.5)).toBe(true);
    expect(inBbox(Number.NaN, -122)).toBe(false);
  });

  it('a point query of bboxCoverRadiusNm around the centre covers every corner', () => {
    const r = bboxCoverRadiusNm(BAY_AREA_BBOX);
    const c = bboxCenter(BAY_AREA_BBOX);
    expect(r).toBe(58);
    expect(distanceNm(c.lat, c.lon, BAY_AREA_BBOX.south, BAY_AREA_BBOX.west)).toBeLessThanOrEqual(r);
    // One degree of latitude is 60 nm.
    expect(distanceNm(37, -122, 38, -122)).toBeCloseTo(60.04, 1);
  });
});

describe('fromTracePoint', () => {
  it('maps the README example point, taking flight, squawk and category from its aircraft object', () => {
    const fix = fromTracePoint(README_TRACE, README_TRACE.trace[0]);
    expect(fix).toEqual<FlightPoint>({
      ts: Math.round((1663259853.016 + 7016.59) * 1000),
      hex: '3c66b0',
      flight: 'DLH7YA',
      registration: 'D-AIUP',
      typeCode: 'A320',
      lat: 49.2633,
      lon: 10.614239,
      altBaroFt: 25125,
      altGeomFt: 25875,
      onGround: false,
      gsKt: 446.5,
      trackDeg: 309,
      baroRateFpm: -2176,
      geomRateFpm: -2208,
      category: 'A3',
      squawk: '1000',
      posType: 'adsb_icao',
      source: 'archive',
    });
  });

  it('reads "ground" as on the ground with no barometric altitude', () => {
    const fix = fromTracePoint({ icao: 'A1B2C3', timestamp: 1_700_000_000 }, [1.5, SFO.lat, SFO.lon, 'ground', 12.3, 281.2, 0, null, null]);
    expect(fix).toMatchObject({ hex: 'a1b2c3', ts: 1_700_000_001_500, onGround: true, altBaroFt: null, altGeomFt: null, gsKt: 12.3, trackDeg: 281.2 });
    expect(fix?.flight).toBeNull();
    expect(fix?.posType).toBeNull();
  });

  it('moves a geometric altitude and rate (flags 8 and 4) out of the barometric fields', () => {
    const fix = fromTracePoint({ icao: 'a1b2c3', timestamp: 0 }, [10, SFO.lat, SFO.lon, 3000, 150, 10, 8 | 4, 640]);
    expect(fix).toMatchObject({ altBaroFt: null, altGeomFt: 3000, baroRateFpm: null, geomRateFpm: 640 });
  });

  it('rejects points without a usable time, hex or position', () => {
    const header = { icao: 'a1b2c3', timestamp: 1_700_000_000 };
    expect(fromTracePoint(header, [1, 91, 0, 1000])).toBeNull();
    expect(fromTracePoint(header, [1, null, 0, 1000])).toBeNull();
    expect(fromTracePoint(header, ['1', 37, -122, 1000])).toBeNull();
    expect(fromTracePoint({ icao: 'xyz', timestamp: 1 }, [1, 37, -122, 1000])).toBeNull();
    expect(fromTracePoint({ icao: 'a1b2c3' }, [1, 37, -122, 1000])).toBeNull();
    expect(fromTracePoint(header, { 0: 1 })).toBeNull();
  });

  it('drops malformed optional fields one by one instead of the point', () => {
    const fix = fromTracePoint({ icao: 'a1b2c3', timestamp: 0, r: 7 }, [1, 37.5, -122.3, 'high', -5, 400, 'x', 'fast', { flight: '', squawk: '9999', category: 'Z9' }]);
    expect(fix).toMatchObject({ altBaroFt: null, onGround: false, gsKt: null, trackDeg: null, baroRateFpm: null, flight: null, squawk: null, category: null, registration: null });
  });
});

describe('fromTrace', () => {
  it('carries callsign, squawk and category forward to points without an aircraft object', () => {
    const fixes = fromTrace(README_TRACE);
    expect(fixes).toHaveLength(2);
    expect(fixes[1]).toMatchObject({ flight: 'DLH7YA', squawk: '1000', category: 'A3', altBaroFt: 24825, altGeomFt: 25550, geomRateFpm: -2144 });
  });

  it('resets the carried details at the start of a new leg', () => {
    const fixes = fromTrace({
      icao: 'a1b2c3',
      timestamp: 0,
      trace: [
        [0, 37.6, -122.4, 'ground', 0, 0, 0, null, { flight: 'UAL1', squawk: '1200' }],
        [60, 37.6, -122.4, 'ground', 0, 0, 2, null, null],
      ],
    });
    expect(fixes.map((fix) => fix.flight)).toEqual(['UAL1', null]);
  });

  it('keeps only fixes inside the box, still carrying details through points outside it', () => {
    const fixes = fromTrace(
      {
        icao: 'a1b2c3',
        timestamp: 0,
        trace: [
          [0, 40, -100, 30000, 450, 270, 0, 0, { flight: 'SWA22' }],
          [5, 'bad'],
          [600, SFO.lat, SFO.lon, 2000, 160, 280, 0, -700, null],
        ],
      },
      { bbox: BAY_AREA_BBOX },
    );
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ ts: 600_000, flight: 'SWA22' });
  });

  it('returns nothing for something that is not a trace file', () => {
    expect(fromTrace(null)).toEqual([]);
    expect(fromTrace({ icao: 'a1b2c3', trace: 'no' })).toEqual([]);
  });
});

describe('fromReadsbAircraft', () => {
  const AC = {
    hex: 'A0B1C2',
    type: 'adsb_icao',
    flight: 'UAL123  ',
    r: 'N12345',
    t: 'B39M',
    alt_baro: 4025,
    alt_geom: 4150,
    gs: 210.4,
    track: 118.3,
    baro_rate: -832,
    geom_rate: -800,
    squawk: '4621',
    category: 'A3',
    lat: 37.61,
    lon: -122.36,
    seen_pos: 1.2,
    seen: 0.3,
  };

  it('times the fix at now - seen_pos and keeps every field it maps', () => {
    expect(fromReadsbAircraft(AC, 1_762_700_000.5)).toEqual<FlightPoint>({
      ts: 1_762_699_999_300,
      hex: 'a0b1c2',
      flight: 'UAL123',
      registration: 'N12345',
      typeCode: 'B39M',
      lat: 37.61,
      lon: -122.36,
      altBaroFt: 4025,
      altGeomFt: 4150,
      onGround: false,
      gsKt: 210.4,
      trackDeg: 118.3,
      baroRateFpm: -832,
      geomRateFpm: -800,
      category: 'A3',
      squawk: '4621',
      posType: 'adsb_icao',
      source: 'live',
    });
  });

  it('on the ground: no barometric altitude, true heading when there is no track', () => {
    const fix = fromReadsbAircraft({ hex: 'a0b1c2', alt_baro: 'ground', true_heading: 280.5, gs: 3, lat: 37.6, lon: -122.38, seen_pos: 0 }, 100);
    expect(fix).toMatchObject({ onGround: true, altBaroFt: null, trackDeg: 280.5, ts: 100_000 });
  });

  it('needs a current position: lastPosition and rough receiver positions do not count', () => {
    expect(fromReadsbAircraft({ hex: 'a0b1c2', lastPosition: { lat: 37.6, lon: -122.4, seen_pos: 90 } }, 100)).toBeNull();
    expect(fromReadsbAircraft({ hex: 'a0b1c2', rr_lat: 37.6, rr_lon: -122.4 }, 100)).toBeNull();
    expect(fromReadsbAircraft({ ...AC, hex: 'zzzzzz' }, 100)).toBeNull();
    expect(fromReadsbAircraft(AC, Number.NaN)).toBeNull();
  });

  it('keeps non-ICAO (~) addresses', () => {
    expect(fromReadsbAircraft({ ...AC, hex: '~1a2b3c', type: 'tisb_other' }, 100)?.hex).toBe('~1a2b3c');
  });
});

describe('response helpers', () => {
  it('reads now in seconds or milliseconds', () => {
    expect(readsbNowSeconds(1_762_700_000.5)).toBe(1_762_700_000.5);
    expect(readsbNowSeconds(1_762_700_000_500)).toBe(1_762_700_000.5);
    expect(readsbNowSeconds('1')).toBeNull();
  });

  it('finds the aircraft list under ac (v2 API) or aircraft (aircraft.json)', () => {
    expect(parseReadsbResponse({ now: 1_762_700_000_000, ac: [1], total: 1 })).toEqual({ nowSec: 1_762_700_000, aircraft: [1] });
    expect(parseReadsbResponse({ now: 1_762_700_000, aircraft: [] })).toEqual({ nowSec: 1_762_700_000, aircraft: [] });
    expect(parseReadsbResponse({ now: 1, msg: 'No error' })).toBeNull();
    expect(parseReadsbResponse([])).toBeNull();
  });

  it('normalises hex ids', () => {
    expect(normalizeHex(' AbC123 ')).toBe('abc123');
    expect(normalizeHex('abc12')).toBeNull();
    expect(normalizeHex(0xabc123)).toBeNull();
  });
});

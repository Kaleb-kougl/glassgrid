import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVE_INTERVAL_MS,
  FlightsApiResponseSchema,
  LIVE_FIXTURES,
  LiveSourceConfigSchema,
  LiveStateSchema,
  INITIAL_LIVE_STATE,
  MIN_LIVE_INTERVAL_MS,
  liveFlightsUrl,
  sameLiveSource,
} from './live.js';
import { EngineEventSchema, EngineRequestSchema, EngineResponseSchema } from '../protocol/engine.js';

/* The live-flights contract: source configs, the endpoint's envelope and the engine protocol's live messages. */

const body = {
  now: 1_794_268_000_000,
  fetchedAt: 1_794_268_000_400,
  stale: false,
  source: 'adsb.lol',
  attribution: 'Data © adsb.lol contributors (ODbL 1.0)',
  license: 'ODbL-1.0',
  ac: [{ hex: 'a1b2c3', lat: 37.6, lon: -122.4, alt_baro: 'ground' }],
};

describe('live source config', () => {
  it('defaults to a 20 s cadence no faster than the 10 s CDN window', () => {
    expect(DEFAULT_LIVE_INTERVAL_MS).toBe(20_000);
    expect(MIN_LIVE_INTERVAL_MS).toBe(10_000);
    expect(LiveSourceConfigSchema.safeParse({ kind: 'live', intervalMs: 9_999 }).success).toBe(false);
    expect(LiveSourceConfigSchema.safeParse({ kind: 'live', intervalMs: 10_000 }).success).toBe(true);
    // A replay makes no requests, so it may tick faster.
    expect(LiveSourceConfigSchema.safeParse({ kind: 'replay', fixture: 'flights-bay-30min', intervalMs: 1_000 }).success).toBe(true);
  });

  it('carries no URL or path: the host configures those', () => {
    expect(LiveSourceConfigSchema.safeParse({ kind: 'live', url: 'https://evil.example/' }).success).toBe(false);
    expect(LiveSourceConfigSchema.safeParse({ kind: 'replay', fixture: '/etc/passwd' }).success).toBe(false);
  });

  it('names the committed fixtures', () => {
    expect(Object.keys(LIVE_FIXTURES)).toEqual(['flights-bay-30min', 'flights-bay-day']);
    expect(LIVE_FIXTURES['flights-bay-30min'].file).toBe('flights-bay-30min.parquet');
  });

  it('sameLiveSource compares kind and fixture only', () => {
    expect(sameLiveSource({ kind: 'live' }, { kind: 'live', intervalMs: 30_000 })).toBe(true);
    expect(sameLiveSource({ kind: 'replay', fixture: 'flights-bay-day' }, { kind: 'replay', fixture: 'flights-bay-day', speed: 2 })).toBe(true);
    expect(sameLiveSource({ kind: 'replay', fixture: 'flights-bay-day' }, { kind: 'replay', fixture: 'flights-bay-30min' })).toBe(false);
    expect(sameLiveSource({ kind: 'live' }, { kind: 'replay', fixture: 'flights-bay-30min' })).toBe(false);
  });
});

describe('the endpoint', () => {
  it('lives at /api/flights on the site origin, outside the app base', () => {
    expect(liveFlightsUrl('https://kalebkougl-portfolio.vercel.app')).toBe('https://kalebkougl-portfolio.vercel.app/api/flights');
    expect(liveFlightsUrl('http://localhost:5173')).toBe('http://localhost:5173/api/flights');
  });

  it('validates the envelope and leaves aircraft to the adapter', () => {
    expect(FlightsApiResponseSchema.parse(body).ac).toHaveLength(1);
    expect(FlightsApiResponseSchema.safeParse({ ...body, ac: [1, 'x', null] }).success).toBe(true);
    for (const broken of [{ ...body, now: '1794268000000' }, { ...body, source: 'other' }, { ...body, stale: undefined }, { ...body, ac: {} }]) {
      expect(FlightsApiResponseSchema.safeParse(broken).success).toBe(false);
    }
  });
});

describe('engine protocol', () => {
  it('has live requests, a liveState reply and a liveState event', () => {
    expect(EngineRequestSchema.parse({ kind: 'liveStart', requestId: 'r1', source: { kind: 'live' } })).toMatchObject({ kind: 'liveStart' });
    expect(EngineRequestSchema.parse({ kind: 'liveVisibility', requestId: 'r2', visible: false })).toMatchObject({ visible: false });
    expect(EngineRequestSchema.safeParse({ kind: 'liveSetSource', requestId: 'r3', source: { kind: 'replay' } }).success).toBe(false);
    const state = LiveStateSchema.parse({
      source: { kind: 'replay', fixture: 'flights-bay-30min', speed: 4 },
      feed: {
        kind: 'replay',
        status: 'live',
        paused: false,
        attribution: 'x',
        license: 'ODbL-1.0',
        lastSuccessAt: 1,
        dataClockMs: 2,
        nextAttemptAt: 3,
        failures: 0,
        error: null,
        ended: false,
      },
      rowCount: 10,
      lastBatch: { received: 12, inserted: 10, expired: 0, dataClockMs: 2 },
      ingestError: null,
    });
    expect(EngineResponseSchema.parse({ kind: 'liveState', requestId: 'r1', state })).toMatchObject({ kind: 'liveState' });
    expect(EngineEventSchema.parse({ type: 'liveState', state: INITIAL_LIVE_STATE })).toMatchObject({ type: 'liveState' });
  });
});

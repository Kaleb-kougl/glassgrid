import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADSBLOL_ATTRIBUTION, type FlightBatch, type FlightPoint } from '@glassgrid/core';
import { ReplaySource, memoryFixtureReader, type FixtureReader } from './replay-source';

/*
 * The replay clock under fake timers, with a fixture in memory: windows
 * (previous tick, this tick], the speed multiplier, the end, pause/resume
 * and determinism. The Parquet reader and the table are covered by
 * replay-gate.test.ts on both drivers.
 */

const START = Date.parse('2026-11-09T23:27:00.000Z');

function point(ts: number, hex = 'a1b2c3'): FlightPoint {
  return {
    ts,
    hex,
    flight: null,
    registration: null,
    typeCode: null,
    lat: 37.6,
    lon: -122.4,
    altBaroFt: null,
    altGeomFt: null,
    onGround: true,
    gsKt: null,
    trackDeg: null,
    baroRateFpm: null,
    geomRateFpm: null,
    category: null,
    squawk: null,
    posType: null,
    source: 'archive',
  };
}

/** A fix every 7 s for 10 minutes from START, for two aircraft (the second offset by 3 s). */
const FIXTURE = Array.from({ length: 86 }, (_, i) => [point(START + i * 7_000), point(START + 3_000 + i * 7_000, 'b00001')]).flat();
const LAST = START + 3_000 + 85 * 7_000;

function replay(options: { intervalMs?: number; speed?: number; reader?: FixtureReader } = {}) {
  const batches: FlightBatch[] = [];
  const source = new ReplaySource({
    reader: options.reader ?? memoryFixtureReader([...FIXTURE].reverse()),
    sink: (batch) => Promise.resolve(void batches.push(batch)),
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
    ...(options.speed === undefined ? {} : { speed: options.speed }),
  });
  return { source, batches };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse('2026-11-10T20:00:00.000Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ReplaySource', () => {
  it('emits (previous tick, this tick] every interval, in time order, and ends after the last fix', async () => {
    const { source, batches } = replay({ intervalMs: 20_000, speed: 6 });
    expect(source.state()).toMatchObject({ kind: 'replay', status: 'stopped', attribution: ADSBLOL_ATTRIBUTION, license: 'ODbL-1.0' });
    source.start();
    await vi.advanceTimersByTimeAsync(0);
    // Tick 0: everything up to the start position (the first fix).
    expect(batches.map((batch) => [batch.dataClockMs, batch.points.length])).toEqual([[START, 1]]);
    await vi.advanceTimersByTimeAsync(20_000);
    // 20 s at 6x = 2 minutes of fixture: (START, START + 120 s].
    const second = batches[1];
    expect(second?.dataClockMs).toBe(START + 120_000);
    const times = second?.points.map((p) => p.ts) ?? [];
    expect(times.length).toBeGreaterThan(0);
    expect(times.every((ts) => ts > START && ts <= START + 120_000)).toBe(true);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(source.state()).toMatchObject({ status: 'live', dataClockMs: START + 120_000, nextAttemptAt: Date.now() + 20_000 });

    await vi.advanceTimersByTimeAsync(10 * 20_000);
    // 10 minutes of fixture at 2 minutes a tick: ticks 0..5, and the sixth reaches past the last fix.
    expect(batches.map((batch) => batch.dataClockMs)).toEqual([0, 1, 2, 3, 4, 5].map((k) => START + k * 120_000));
    expect(batches.flatMap((batch) => batch.points)).toEqual([...FIXTURE].sort((a, b) => a.ts - b.ts));
    expect(LAST).toBeLessThanOrEqual(START + 5 * 120_000);
    expect(source.state()).toMatchObject({ status: 'stopped', ended: true, nextAttemptAt: null });
    source.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(batches).toHaveLength(6);
  });

  it('is deterministic: pauses, late timers and slow sinks change when ticks happen, never what they hold', async () => {
    const reference = replay({ intervalMs: 5_000, speed: 10 });
    reference.source.start();
    await vi.advanceTimersByTimeAsync(5_000 * 20);
    expect(reference.source.state().ended).toBe(true);

    const batches: FlightBatch[] = [];
    const source = new ReplaySource({
      reader: memoryFixtureReader(FIXTURE),
      // A sink that takes 7 s (longer than the interval).
      sink: async (batch) => {
        batches.push(batch);
        await new Promise((resolve) => setTimeout(resolve, 7_000));
      },
      intervalMs: 5_000,
      speed: 10,
    });
    source.start();
    await vi.advanceTimersByTimeAsync(3_000);
    source.pause();
    await vi.advanceTimersByTimeAsync(600_000);
    const whilePaused = batches.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(batches).toHaveLength(whilePaused);
    source.resume();
    source.pause();
    source.resume();
    await vi.advanceTimersByTimeAsync(12_000 * 20);
    expect(source.state().ended).toBe(true);
    expect(batches).toEqual(reference.batches);
  });

  it('retries the same tick when the reader fails', async () => {
    const inner = memoryFixtureReader(FIXTURE);
    let fail = 1;
    const reader: FixtureReader = {
      range: () => inner.range(),
      read: (after, upTo) => (fail-- > 0 ? Promise.reject(new Error('disk on fire')) : inner.read(after, upTo)),
      close: () => inner.close(),
    };
    const { source, batches } = replay({ intervalMs: 10_000, reader });
    source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.state()).toMatchObject({ status: 'backoff', failures: 1, error: 'disk on fire' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.state()).toMatchObject({ status: 'live', failures: 0, error: null });
    expect(batches.map((batch) => batch.dataClockMs)).toEqual([START]);
    source.stop();
  });

  it('keeps every position in whole milliseconds at a fractional step (speed 1.0005, 1 s ticks)', async () => {
    const { source, batches } = replay({ intervalMs: 1_000, speed: 1.0005 });
    source.start();
    await vi.advanceTimersByTimeAsync(1_000 * 700);
    expect(source.state().ended).toBe(true);
    expect(batches.every((batch) => Number.isSafeInteger(batch.dataClockMs))).toBe(true);
    expect(batches[3]?.dataClockMs).toBe(START + Math.floor(3 * 1_000.5));
    // Floored positions still tile the fixture: every fix exactly once.
    expect(batches.flatMap((batch) => batch.points)).toEqual([...FIXTURE].sort((a, b) => a.ts - b.ts));
  });

  it('ends at once on an empty fixture', async () => {
    const { source, batches } = replay({ reader: memoryFixtureReader([]) });
    source.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(source.state()).toMatchObject({ status: 'stopped', ended: true });
    expect(batches).toEqual([]);
  });
});

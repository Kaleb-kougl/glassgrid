import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileHandle, TableId } from '@glassgrid/core';
import { Coalescer } from './coalesce';
import { columnValues, createHarness, decode, writeFixtureCsv, type Harness } from './test-support';

/*
 * Grid paging under load: identical in-flight pages share one query, an
 * aborted page interrupts DuckDB only when nobody else wants it, and a fling
 * (many page requests, most abandoned) settles quickly.
 */

const ROWS = 2_000_000;
let h: Harness;
let file: FileHandle;
let table: TableId;

beforeAll(async () => {
  h = await createHarness();
  const path = join(h.dir, 'pages.csv');
  await writeFixtureCsv(path, ROWS);
  ({ file, table } = h.register(path));
  // CSV without Parquet: deep pages are slow OFFSET scans, so sharing and interrupts are observable.
  await h.service.open(file, { parquet: 'never' });
});

afterAll(async () => {
  await h.dispose();
});

const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

describe('Coalescer', () => {
  it('shares a task, aborts it only when every caller has aborted, and restarts after that', async () => {
    const coalescer = new Coalescer<number>();
    let started = 0;
    let aborted = 0;
    const task = (signal: AbortSignal) =>
      new Promise<number>((resolve, reject) => {
        started += 1;
        const timer = setTimeout(() => resolve(started), 50);
        signal.addEventListener('abort', () => {
          aborted += 1;
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
    const a = new AbortController();
    const b = new AbortController();
    const first = outcome(coalescer.run('k', a.signal, task));
    const second = outcome(coalescer.run('k', b.signal, task));
    a.abort();
    expect(await first).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(await second).toEqual({ ok: true, value: 1 });
    expect([started, aborted, coalescer.joinedCount]).toEqual([1, 0, 1]);

    const c = new AbortController();
    const third = outcome(coalescer.run('k', c.signal, task));
    c.abort();
    expect(await third).toMatchObject({ ok: false });
    expect(aborted).toBe(1);
    expect(await coalescer.run('k', undefined, task)).toBe(3);
  });
});

describe('page requests', () => {
  it('coalesce identical in-flight pages into one query', async () => {
    await h.service.clearCache('results');
    const before = h.service.debugState().coalesced;
    const query = { offset: ROWS - 1000, limit: 1000 };
    const [a, b] = await Promise.all([
      h.service.rows(table, query, { viewId: 'grid' }),
      h.service.rows(table, query, { viewId: 'grid-window-2' }),
    ]);
    expect(h.service.debugState().coalesced).toBe(before + 1);
    expect(a.value).toBe(b.value);
    expect(columnValues(decode(a.value), 'id')[0]).toBe(ROWS - 999);
  });

  it('keep running for the remaining caller when one aborts, and interrupt when all abort', async () => {
    await h.service.clearCache('results');
    const query = { offset: ROWS - 2000, limit: 1000 };
    const first = new AbortController();
    const second = new AbortController();
    const a = outcome(h.service.rows(table, query, { signal: first.signal }));
    const b = outcome(h.service.rows(table, query, { signal: second.signal }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    first.abort();
    expect(await a).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    const kept = await b;
    expect(kept.ok).toBe(true);

    await h.service.clearCache('results');
    const third = new AbortController();
    const fourth = new AbortController();
    const c = outcome(h.service.rows(table, query, { signal: third.signal }));
    const d = outcome(h.service.rows(table, query, { signal: fourth.signal }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abortedAt = performance.now();
    third.abort();
    fourth.abort();
    await Promise.all([c, d]);
    // The shared query is interrupted, not left running: the in-flight entry is gone almost at once.
    for (let i = 0; i < 100 && h.service.debugState().inflight > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.service.debugState().inflight).toBe(0);
    expect(performance.now() - abortedAt).toBeLessThan(250);
  });

  it('settle a fling quickly: superseded pages are interrupted, the last ones arrive', async () => {
    await h.service.clearCache('results');
    const controllers: AbortController[] = [];
    const flights: Array<Promise<{ ok: boolean; at: number }>> = [];
    const abortedAt: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const controller = new AbortController();
      controllers.push(controller);
      const offset = ((i * 7919) % 1990) * 1000;
      flights.push(
        h.service.rows(table, { offset, limit: 1000 }, { signal: controller.signal, viewId: 'grid' }).then(
          () => ({ ok: true, at: performance.now() }),
          () => ({ ok: false, at: performance.now() }),
        ),
      );
      if (i >= 3) {
        abortedAt[i - 3] = performance.now();
        controllers[i - 3]?.abort();
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const lastSent = performance.now();
    const results = await Promise.all(flights);
    // Every abandoned page settled within a few ms of its abort (or had already finished).
    results.slice(0, 27).forEach((result, i) => {
      if (!result.ok) expect(result.at - (abortedAt[i] ?? 0)).toBeLessThan(100);
    });
    expect(results.slice(27).every((result) => result.ok)).toBe(true);
    // The last three only compete with each other, not with 27 abandoned scans.
    const lastDone = Math.max(...results.slice(27).map((result) => result.at));
    expect(lastDone - lastSent).toBeLessThan(10_000);
    expect(h.service.debugState().inflight).toBe(0);
  });
});

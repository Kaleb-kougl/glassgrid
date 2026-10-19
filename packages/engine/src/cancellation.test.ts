import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileHandle, TableId } from '@glassgrid/core';
import { createHarness, writeFixtureCsv, type Harness } from './test-support';

/*
 * A CSV large enough that a full scan (profile) or a sort materialization
 * takes well over a hundred milliseconds even on a fast machine (about 160 ms
 * on an M-series Mac), so interrupts are observable.
 */
const ROWS = 2_000_000;

let h: Harness;
let file: FileHandle;
let table: TableId;
let fullProfileMs: number;

beforeAll(async () => {
  h = await createHarness();
  const path = join(h.dir, 'slow.csv');
  await writeFixtureCsv(path, ROWS);
  ({ file, table } = h.register(path));
  await h.service.open(file, { parquet: 'never' });
  const started = performance.now();
  await h.service.profile(table);
  fullProfileMs = performance.now() - started;
  await h.service.clearCache('results');
});

afterAll(async () => {
  await h.dispose();
});

describe('interrupt via AbortSignal', () => {
  it('stops a running scan within a fraction of its full duration', async () => {
    const controller = new AbortController();
    const started = performance.now();
    let abortedAt = Number.NaN;
    const pending = h.service.profile(table, { signal: controller.signal });
    setTimeout(() => {
      abortedAt = performance.now();
      controller.abort();
    }, 20);
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    // Measured from the abort, against what was left of the scan: a fast machine scans 2M rows in ~160 ms,
    // where "half the full scan" left less room than the interrupt itself takes. 100 ms covers that latency.
    const afterAbort = performance.now() - abortedAt;
    const remainingMs = fullProfileMs - (abortedAt - started);
    expect(afterAbort).toBeLessThan(Math.max(remainingMs / 2, 100));
    // The connection is gone, the service is healthy.
    expect((await h.service.count(table)).value).toBe(ROWS);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(h.service.rows(table, { offset: 0, limit: 10 }, { signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
  });
});

describe('sort index builds', () => {
  it('are interrupted when their only view moves on to another query', async () => {
    // A page past the top-K range waits for the index. Observe the outcome
    // right away so the expected rejection is never "unhandled".
    const sorted = h.service
      .rows(table, { offset: 100_000, limit: 100, sort: [{ column: 'amount', direction: 'desc' }] }, { viewId: 'grid' })
      .then(
        () => null,
        (error: unknown) => error,
      );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const started = performance.now();
    const unsorted = await h.service.rows(table, { offset: 0, limit: 100 }, { viewId: 'grid' });
    expect(unsorted.value.byteLength).toBeGreaterThan(0);
    expect(await sorted).toMatchObject({ code: 'superseded' });
    expect(performance.now() - started).toBeLessThan(fullProfileMs);
    expect(h.service.debugState().sortIndexes).toBe(0);
  });

  it('keep running when the same view asks for another page of the same sort', async () => {
    const sort = [{ column: 'category', direction: 'asc' as const }];
    const first = h.service.rows(table, { offset: 0, limit: 100, sort }, { viewId: 'grid2' });
    const second = h.service.rows(table, { offset: 100, limit: 100, sort }, { viewId: 'grid2' });
    const [a, b] = await Promise.all([first, second]);
    expect(a.value.byteLength).toBeGreaterThan(0);
    expect(b.value.byteLength).toBeGreaterThan(0);
    expect(h.service.debugState().sortIndexes).toBe(1);
  });
});

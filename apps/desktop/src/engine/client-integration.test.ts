import { MessageChannel, type MessagePort as NodeMessagePort } from 'node:worker_threads';
import { join } from 'node:path';
import { DataType } from 'apache-arrow';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineRequest, FileHandle, GlassgridBridge, TableId } from '@glassgrid/core';
import { EngineClient, EngineRequestError, isAbandoned } from '../renderer/src/engine-client';
import { EngineSession } from './session';
import { createHarness, writeFixtureCsv, type Harness } from './test-support';

/*
 * The renderer client against a real EngineSession and DuckDB, over a
 * MessageChannel as in the app: fetchPage concurrency and coalescing,
 * AbortSignal all the way to an engine interrupt, and setColumnTypes.
 */

const ROWS = 2_000_000;
let h: Harness;
let file: FileHandle;
let table: TableId;
let client: EngineClient;
let session: EngineSession;
const requests: EngineRequest[] = [];

beforeAll(async () => {
  h = await createHarness();
  const path = join(h.dir, 'client.csv');
  await writeFixtureCsv(path, ROWS);
  ({ file, table } = h.register(path));

  // The client only needs window message listeners (for the port hand-off, simulated below).
  Object.assign(globalThis, { window: { addEventListener: () => undefined, removeEventListener: () => undefined } });
  const { port1, port2 } = new MessageChannel();
  session = new EngineSession(Promise.resolve(h.service), (message) => port2.postMessage(message));
  port2.on('message', (data: EngineRequest) => {
    requests.push(data);
    session.handle(data);
  });
  const bridge = { requestEnginePort: () => undefined } as unknown as GlassgridBridge;
  client = new EngineClient(bridge);
  (client as unknown as { adoptPort(port: NodeMessagePort): void }).adoptPort(port1);
  await client.open(file, { parquet: 'never' });
});

afterAll(async () => {
  client.dispose();
  session.dispose();
  await h.dispose();
});

const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

describe('EngineClient.fetchPage', () => {
  it('runs pages of one view side by side and shares identical in-flight pages', async () => {
    await client.clearCache('results');
    const sent = requests.length;
    const fetchPage = client.pageFetcher(table, { viewId: 'grid' });
    const [a, b, c] = await Promise.all([fetchPage(ROWS - 2000, 1000), fetchPage(ROWS - 1000, 1000), fetchPage(ROWS - 1000, 1000)]);
    expect(Number(a.table.getChild('id')?.get(0))).toBe(ROWS - 1999);
    expect(Number(b.table.getChild('id')?.get(0))).toBe(ROWS - 999);
    expect(c).toBe(b);
    const rows = requests.slice(sent).flatMap((request) => (request.kind === 'rows' ? [request] : []));
    expect(rows).toHaveLength(2);
    expect(rows.every((request) => request.concurrent === true)).toBe(true);
  });

  it('passes sort and filters, and keys the share by them', async () => {
    const byAmount = client.pageFetcher(table, { sort: [{ column: 'amount', direction: 'desc' }] });
    const filtered = client.pageFetcher(table, {
      sort: [{ column: 'amount', direction: 'desc' }],
      filters: [{ kind: 'in', column: 'category', values: ['echo'] }],
    });
    const [sorted, onlyEcho] = await Promise.all([byAmount(0, 5), filtered(0, 5)]);
    // Amounts repeat every 1M rows, so each value appears twice.
    expect([...(sorted.table.getChild('amount') ?? [])]).toEqual([9999.99, 9999.99, 9999.98, 9999.98, 9999.97]);
    expect([...(onlyEcho.table.getChild('category') ?? [])]).toEqual(['echo', 'echo', 'echo', 'echo', 'echo']);
  });

  it('turns an abort into an engine interrupt once no caller wants the page', async () => {
    await client.clearCache('results');
    const fetchPage = client.pageFetcher(table);
    const keepController = new AbortController();
    const dropController = new AbortController();
    const kept = outcome(fetchPage(ROWS - 3000, 1000, keepController.signal));
    const dropped = outcome(fetchPage(ROWS - 3000, 1000, dropController.signal));
    dropController.abort();
    const droppedResult = await dropped;
    expect(droppedResult.ok).toBe(false);
    if (!droppedResult.ok) expect(isAbandoned(droppedResult.error)).toBe(true);
    expect((await kept).ok).toBe(true);
    expect(requests.some((request) => request.kind === 'cancel')).toBe(false);

    await client.clearCache('results');
    const lone = new AbortController();
    const started = performance.now();
    const pending = outcome(fetchPage(ROWS - 4000, 1000, lone.signal));
    await new Promise((resolve) => setTimeout(resolve, 20));
    lone.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(EngineRequestError);
    expect(performance.now() - started).toBeLessThan(500);
    // The cancel crosses the port asynchronously.
    for (let i = 0; i < 100 && requests.at(-1)?.kind !== 'cancel'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(requests.at(-1)).toMatchObject({ kind: 'cancel' });
    for (let i = 0; i < 100 && h.service.debugState().inflight > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.service.debugState().inflight).toBe(0);
  });

  it('rejects an already-aborted page without a round trip', async () => {
    const sent = requests.length;
    const controller = new AbortController();
    controller.abort();
    await expect(client.fetchPage(table, { offset: 0, limit: 10 }, { signal: controller.signal })).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(requests.length).toBe(sent);
  });
});

describe('EngineClient.setColumnTypes', () => {
  it('applies overrides and reports failed casts', async () => {
    const result = await client.setColumnTypes(table, [{ column: 'category', type: 'integer' }]);
    expect(result.columns).toEqual([{ column: 'category', type: 'integer', duckdbType: 'BIGINT', failedCasts: ROWS }]);
    expect(result.table.typeOverrides).toEqual([{ column: 'category', type: 'integer' }]);
    const page = await client.fetchPage(table, { offset: 0, limit: 3 });
    expect([...(page.table.getChild('category') ?? [])]).toEqual([null, null, null]);
    await client.setColumnTypes(table, []);
    const restored = await client.fetchPage(table, { offset: 0, limit: 3 });
    expect([...(restored.table.getChild('category') ?? [])]).toEqual(['alpha', 'bravo', 'charlie']);
  });
});

describe('EngineClient pages around a type change', () => {
  it('never lets a page requested after setColumnTypes join one requested before it finished', async () => {
    await client.clearCache('results');
    const query = { offset: ROWS - 3_000, limit: 1000 };
    const change = client.setColumnTypes(table, [{ column: 'amount', type: 'text' }]);
    // Requested while the engine applies the change: it may be read with either set of types.
    const during = outcome(client.fetchPage(table, query));
    await change;
    const pending = (client as unknown as { pages: Map<string, { table: string }> }).pages;
    expect([...pending.values()].filter((page) => page.table === table)).toEqual([]);
    const after = await client.fetchPage(table, query);
    expect(DataType.isUtf8(after.table.schema.fields.find((field) => field.name === 'amount')?.type)).toBe(true);
    await during;
    await client.setColumnTypes(table, []);
  });
});

describe('EngineClient.closeTable', () => {
  it('frees the table and the id reopens on the next request', async () => {
    const before = h.service.debugState().tables;
    await client.closeTable(table);
    expect(h.service.debugState().tables).toBe(before - 1);
    const page = await client.fetchPage(table, { offset: 0, limit: 2 });
    expect(page.table.numRows).toBe(2);
    expect(h.service.debugState().tables).toBe(before);
  });
});

describe('EngineClient.onRestarted', () => {
  it('rejects pending requests as abandoned and tells listeners once the new port is in', async () => {
    let restarts = 0;
    const off = client.onRestarted(() => (restarts += 1));
    const pending = outcome(client.count(table, { viewId: 'restart-probe', filters: [{ kind: 'notNull', column: 'amount' }] }));
    const { port1, port2 } = new MessageChannel();
    port2.on('message', (data: EngineRequest) => session.handle(data));
    (client as unknown as { adoptPort(port: NodeMessagePort): void }).adoptPort(port1);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(isAbandoned(result.error)).toBe(true);
    expect(restarts).toBe(1);
    off();
  });
});

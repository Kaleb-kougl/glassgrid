import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineRequest, EngineResponse, FileHandle, TableId } from '@glassgrid/core';
import { EngineSession } from './session';
import { createHarness, decode, writeFixtureCsv, type Harness } from './test-support';

const ROWS = 2_000_000;

let h: Harness;
let file: FileHandle;
let table: TableId;

beforeAll(async () => {
  h = await createHarness();
  const path = join(h.dir, 'session.csv');
  await writeFixtureCsv(path, ROWS);
  ({ file, table } = h.register(path));
});

afterAll(async () => {
  await h.dispose();
});

function connect() {
  const sent: EngineResponse[] = [];
  const session = new EngineSession(Promise.resolve(h.service), (message) => sent.push(message));
  const send = (request: EngineRequest | Record<string, unknown>) => session.handle(request);
  const replyTo = async (requestId: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = sent.find((m) => m.kind !== 'event' && m.requestId === requestId);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`No reply to ${requestId}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { session, sent, send, replyTo };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('EngineSession', () => {
  it('opens, pages and counts', async () => {
    const { send, replyTo } = connect();
    send({ kind: 'open', requestId: 'o1', file, parquet: 'never' });
    expect(await replyTo('o1')).toMatchObject({ kind: 'opened', table: { id: table, usingParquetCache: false } });

    send({ kind: 'rows', requestId: 'r1', viewId: 'grid', seq: 1, table, query: { offset: 5, limit: 2 } });
    const rows = await replyTo('r1');
    expect(rows.kind).toBe('arrow');
    if (rows.kind === 'arrow') {
      expect(rows.cached).toBe(false);
      expect([...(decode(rows.ipc).getChild('id') ?? [])]).toEqual([6n, 7n]);
    }

    send({ kind: 'count', requestId: 'c1', viewId: 'count', seq: 1, table });
    expect(await replyTo('c1')).toMatchObject({ kind: 'count', rowCount: ROWS, cached: false });
  });

  it('answers malformed requests with bad_request and never throws', async () => {
    const { send, replyTo, sent } = connect();
    send({ kind: 'rows', requestId: 'bad1', viewId: 'grid', seq: 1, table, query: { offset: 0, limit: 5000 } });
    expect(await replyTo('bad1')).toMatchObject({ kind: 'error', code: 'bad_request' });
    send({ kind: 'dropTable' });
    expect(sent.at(-1)).toMatchObject({ kind: 'error', requestId: null, code: 'bad_request' });
    send({ kind: 'count', requestId: 'p1', viewId: 'v', seq: 1, table: '/etc/passwd' });
    expect(await replyTo('p1')).toMatchObject({ code: 'bad_request' });
  });

  it('reports unknown tables and the aggregate stub with codes', async () => {
    const { send, replyTo } = connect();
    send({ kind: 'count', requestId: 'u1', viewId: 'v', seq: 1, table: 'tb_00000000-0000-0000-0000-000000000000' });
    expect(await replyTo('u1')).toMatchObject({ kind: 'error', code: 'unknown_table' });
    send({ kind: 'aggregate', requestId: 'a1', viewId: 'chart', seq: 1, table, spec: { mark: 'bar' } });
    expect(await replyTo('a1')).toMatchObject({ kind: 'error', code: 'not_implemented' });
  });

  it('drops the response of a request superseded by a newer seq for the same view', async () => {
    const { send, replyTo, sent } = connect();
    await h.service.clearCache('results');
    send({ kind: 'profile', requestId: 'slow', viewId: 'panel', seq: 1, table });
    await settle(20);
    send({ kind: 'count', requestId: 'fast', viewId: 'panel', seq: 2, table });
    expect(await replyTo('fast')).toMatchObject({ kind: 'count' });
    await settle(1500);
    expect(sent.find((m) => m.kind !== 'event' && m.requestId === 'slow')).toBeUndefined();

    // An older seq arriving late is refused outright.
    send({ kind: 'count', requestId: 'stale', viewId: 'panel', seq: 1, table });
    expect(await replyTo('stale')).toMatchObject({ kind: 'error', code: 'superseded' });
  });

  it('does not let one view supersede another', async () => {
    const { send, replyTo } = connect();
    send({ kind: 'rows', requestId: 'g', viewId: 'grid', seq: 10, table, query: { offset: 0, limit: 3 } });
    send({ kind: 'rows', requestId: 'c', viewId: 'chart', seq: 1, table, query: { offset: 3, limit: 3 } });
    expect(await replyTo('g')).toMatchObject({ kind: 'arrow' });
    expect(await replyTo('c')).toMatchObject({ kind: 'arrow' });
  });

  it('answers an explicit cancel right away and drops the late result', async () => {
    const { send, replyTo, sent } = connect();
    await h.service.clearCache('results');
    send({ kind: 'profile', requestId: 'victim', viewId: 'x', seq: 1, table });
    await settle(20);
    const started = performance.now();
    send({ kind: 'cancel', requestId: 'k1', target: 'victim' });
    expect(await replyTo('victim')).toMatchObject({ kind: 'error', code: 'cancelled' });
    expect(performance.now() - started).toBeLessThan(100);
    await settle(1000);
    expect(sent.filter((m) => m.kind !== 'event' && m.requestId === 'victim')).toHaveLength(1);
  });

  it('forwards engine events and reports cache stats', async () => {
    const { send, replyTo, sent } = connect();
    send({ kind: 'ensureParquetCache', requestId: 'pq', table });
    expect(await replyTo('pq', 60_000)).toMatchObject({ kind: 'parquetCache', table: { usingParquetCache: true } });
    expect(sent.some((m) => m.kind === 'event' && m.event.type === 'parquetReady')).toBe(true);

    send({ kind: 'cacheStats', requestId: 's1' });
    const stats = await replyTo('s1');
    expect(stats).toMatchObject({ kind: 'cacheStats', parquet: { files: 1 }, results: { maxBytes: 256 * 1024 * 1024 } });

    send({ kind: 'clearCache', requestId: 'cc', scope: 'all' });
    expect(await replyTo('cc')).toEqual({ kind: 'ack', requestId: 'cc' });
  });

  it('reopens tables on demand after an engine restart (ids stay valid)', async () => {
    const path = join(h.dir, 'restart.csv');
    await writeFixtureCsv(path, 100);
    const registered = h.register(path);
    // A fresh service only knows the file registration that main replays.
    const service = await h.restart();
    service.registerFile(registered.file, path);
    const sent: EngineResponse[] = [];
    const session = new EngineSession(Promise.resolve(service), (message) => sent.push(message));
    session.handle({ kind: 'count', requestId: 'after', viewId: 'v', seq: 1, table: registered.table });
    await expect.poll(() => sent.find((m) => m.kind === 'count')).toMatchObject({ rowCount: 100 });
    // Put the shared service back for any later test.
    h.service = service;
    service.registerFile(file, join(h.dir, 'session.csv'));
  });

  it('reports engine_unavailable when DuckDB failed to start', async () => {
    const sent: EngineResponse[] = [];
    const failed = Promise.reject(new Error('boom'));
    const session = new EngineSession(failed, (message) => sent.push(message));
    session.handle({ kind: 'cacheStats', requestId: 'x' });
    await expect.poll(() => sent[0]).toMatchObject({ kind: 'error', code: 'engine_unavailable' });
  });
});

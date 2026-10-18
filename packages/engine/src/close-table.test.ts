import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EngineResponse, FileHandle, TableId } from '@glassgrid/core';
import { EngineSession } from './session';
import { createHarness, writeFixtureCsv, type Harness } from './test-support';

/*
 * `closeTable` (protocol) frees a table's DuckDB instance once no renderer
 * session holds it: a new file replacing the current one, or a window closing.
 */

let h: Harness;
let small: { file: FileHandle; table: TableId };
let big: { file: FileHandle; table: TableId };

beforeAll(async () => {
  h = await createHarness();
  await writeFixtureCsv(join(h.dir, 'small.csv'), 1_000);
  await writeFixtureCsv(join(h.dir, 'big.csv'), 2_000_000);
  small = h.register(join(h.dir, 'small.csv'));
  big = h.register(join(h.dir, 'big.csv'));
});

afterAll(async () => {
  await h.dispose();
});

function connect() {
  const sent: EngineResponse[] = [];
  const session = new EngineSession(Promise.resolve(h.service), (message) => sent.push(message));
  let id = 0;
  const request = async (body: Record<string, unknown>, timeoutMs = 30_000) => {
    const requestId = `q${(id += 1)}`;
    session.handle({ ...body, requestId });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = sent.find((m) => m.kind !== 'event' && m.requestId === requestId);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`No reply to ${requestId}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { session, request };
}

const openTables = () => h.service.debugState().tables;

describe('closeTable', () => {
  it('closes a table once every session that used it lets go, and reopens it on demand', async () => {
    const a = connect();
    const b = connect();
    expect(await a.request({ kind: 'open', file: small.file, parquet: 'never' })).toMatchObject({ kind: 'opened' });
    expect(await b.request({ kind: 'count', viewId: 'status', seq: 1, table: small.table })).toMatchObject({ rowCount: 1_000 });
    const before = openTables();
    const spill = join(h.dir, 'cache', 'duckdb-tmp', small.table);

    expect(await a.request({ kind: 'closeTable', table: small.table })).toMatchObject({ kind: 'ack' });
    expect(openTables()).toBe(before);
    expect(await b.request({ kind: 'closeTable', table: small.table })).toMatchObject({ kind: 'ack' });
    expect(openTables()).toBe(before - 1);
    expect(existsSync(spill)).toBe(false);

    // Undo back to the file: the id still works while main keeps the file registered.
    expect(await b.request({ kind: 'rows', viewId: 'grid', seq: 2, table: small.table, query: { offset: 0, limit: 5 } })).toMatchObject({ kind: 'arrow' });
    expect(openTables()).toBe(before);
    expect(await b.request({ kind: 'closeTable', table: small.table })).toMatchObject({ kind: 'ack' });
    expect(openTables()).toBe(before - 1);
    // Closing a table that is not open is a no-op.
    expect(await a.request({ kind: 'closeTable', table: small.table })).toMatchObject({ kind: 'ack' });
  });

  it('releases a session’s tables when its connection closes', async () => {
    const a = connect();
    await a.request({ kind: 'open', file: small.file, parquet: 'never' });
    const before = openTables();
    a.session.dispose();
    await expect.poll(openTables).toBe(before - 1);
  });

  it('interrupts queries still running on the table and closes it cleanly', async () => {
    const a = connect();
    await a.request({ kind: 'open', file: big.file, parquet: 'never' });
    const before = openTables();
    // A full-table scan (the profile) still running when the table closes.
    const profile = a.request({ kind: 'profile', viewId: 'profile', seq: 1, table: big.table }, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const closed = a.request({ kind: 'closeTable', table: big.table }, 60_000);
    expect(await profile).toMatchObject({ kind: 'error' });
    expect(await closed).toMatchObject({ kind: 'ack' });
    expect(openTables()).toBe(before - 1);
    expect(await a.request({ kind: 'count', viewId: 'status', seq: 1, table: big.table }, 60_000)).toMatchObject({ rowCount: 2_000_000 });
  });

  it('refuses a malformed table id', async () => {
    const a = connect();
    expect(await a.request({ kind: 'closeTable', table: '../etc' })).toMatchObject({ kind: 'error', code: 'bad_request' });
  });
});

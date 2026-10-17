/*
 * Shared helpers for the engine's Vitest suites (plain Node, real DuckDB).
 * Not imported by production code.
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { tableFromIPC, type Table } from 'apache-arrow';
import { tableIdForFile, toFileHandle, type FileHandle, type TableId } from '@glassgrid/core';
import { QueryService, type QueryServiceOptions } from './query-service';

export const CATEGORIES = ['alpha', 'bravo', 'charlie', 'delta', 'echo'] as const;

/** Same shape as the E2E fixture: id,category,amount,created_on. Row i (0-based) has id i+1. */
export function fixtureRow(i: number): { id: number; category: string; amount: number; createdOn: string } {
  const pad2 = (value: number) => String(value).padStart(2, '0');
  return {
    id: i + 1,
    category: CATEGORIES[i % CATEGORIES.length] ?? 'alpha',
    amount: ((i * 7919) % 1_000_000) / 100,
    createdOn: `2026-${pad2((i % 12) + 1)}-${pad2((i % 28) + 1)}`,
  };
}

export async function writeLines(path: string, header: string, lines: Iterable<string>): Promise<void> {
  const out = createWriteStream(path, { encoding: 'utf8' });
  out.write(`${header}\n`);
  let chunk = '';
  for (const line of lines) {
    chunk += `${line}\n`;
    if (chunk.length > 1 << 20) {
      if (!out.write(chunk)) await once(out, 'drain');
      chunk = '';
    }
  }
  out.write(chunk);
  out.end();
  await finished(out);
}

export async function writeFixtureCsv(path: string, rows: number): Promise<void> {
  await writeLines(path, 'id,category,amount,created_on', fixtureLines(rows));
}

function* fixtureLines(rows: number): Generator<string> {
  for (let i = 0; i < rows; i += 1) {
    const row = fixtureRow(i);
    yield `${row.id},${row.category},${row.amount},${row.createdOn}`;
  }
}

export interface Harness {
  dir: string;
  cacheDir: string;
  service: QueryService;
  /** Register a file the way main would and return its handle and table id. */
  register(path: string): { file: FileHandle; table: TableId };
  /** Create another service over the same cache folder (e.g. to simulate a restart). */
  restart(options?: Partial<QueryServiceOptions>): Promise<QueryService>;
  dispose(): Promise<void>;
}

export async function createHarness(options: Partial<QueryServiceOptions> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'glassgrid-engine-'));
  const cacheDir = join(dir, 'cache', 'parquet');
  const services: QueryService[] = [];
  const make = async (extra: Partial<QueryServiceOptions> = {}) => {
    const created = await QueryService.create({ cacheDir, ...options, ...extra });
    services.push(created);
    return created;
  };
  const harness: Harness = {
    dir,
    cacheDir,
    service: await make(),
    register(path) {
      const file = toFileHandle(randomUUID());
      harness.service.registerFile(file, path);
      return { file, table: tableIdForFile(file) };
    },
    async restart(extra) {
      harness.service.close();
      harness.service = await make(extra);
      return harness.service;
    },
    async dispose() {
      for (const service of services) service.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

export function decode(ipc: Uint8Array): Table {
  return tableFromIPC(ipc);
}

/** Column values of an Arrow table as plain JS (bigint -> number). */
export function columnValues(table: Table, name: string): unknown[] {
  const column = table.getChild(name);
  if (!column) throw new Error(`No column ${name}`);
  return [...column].map((value: unknown) => (typeof value === 'bigint' ? Number(value) : value));
}

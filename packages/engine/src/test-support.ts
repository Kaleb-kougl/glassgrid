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
import type { DuckDriver } from './driver';
import { createNativeDriver } from './native/driver';
import { QueryService, type QueryServiceOptions } from './query-service';

/** Which driver the suite runs against: `GLASSGRID_ENGINE_DRIVER=native` (default) or `wasm`. */
export const DRIVER_NAME: 'native' | 'wasm' = process.env['GLASSGRID_ENGINE_DRIVER'] === 'wasm' ? 'wasm' : 'native';
export const isWasm = DRIVER_NAME === 'wasm';

let wasmDriver: Promise<DuckDriver> | undefined;

/**
 * The driver for this run. The WASM driver shares one DuckDB-WASM instance
 * per process (see wasm/driver.ts), allowed to read the OS temp folder where
 * the tests write their fixtures.
 */
export async function testDriver(): Promise<DuckDriver> {
  if (DRIVER_NAME === 'native') return createNativeDriver();
  wasmDriver ??= import('./wasm/node').then(async ({ createNodeWasmDriver }) => {
    const driver = await createNodeWasmDriver({ allowedRoots: [tmpdir()] });
    await driver.start();
    return driver;
  });
  return wasmDriver;
}

/**
 * Whether this run's driver reads and writes Parquet. DuckDB-WASM needs its
 * Parquet extension, fetched from an extension repository; without one the
 * Parquet-backed variants of the tests are skipped (CSV variants still run).
 */
export const hasParquet = (await testDriver()).capabilities.parquet;

/**
 * Latency bound for assertions about how quickly something answers. On
 * DuckDB-WASM the engine shares its thread with DuckDB, so an answer can wait
 * for the running DuckDB step (up to a few hundred ms) before the event loop
 * runs; native answers are bounded as written.
 */
export function latencyBudget(nativeMs: number): number {
  return isWasm ? Math.max(nativeMs, 1_500) : nativeMs;
}

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

/** Deterministic PRNG (mulberry32): the same seed always yields the same sequence. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PAYMENT_TYPES = ['Credit card', 'Cash', 'No charge', 'Dispute', 'Unknown'] as const;

/**
 * A taxi-like table for cross-filter tests and the cross-filter bench:
 * `pickup_datetime` (TIMESTAMP over 91 days), `trip_distance` and
 * `fare_amount` (DOUBLE, 2 decimals, skewed), `payment_type` (5 values,
 * skewed), `passenger_count` (1 to 6, about 2% empty) and `PULocationID`
 * (1 to 265). Deterministic for a given row count and seed.
 */
export function* taxiLikeLines(rows: number, seed = 42): Generator<string> {
  const random = mulberry32(seed);
  const start = Date.UTC(2024, 2, 1);
  const span = 91 * 86_400_000;
  const pad = (value: number) => String(value).padStart(2, '0');
  for (let i = 0; i < rows; i += 1) {
    const ms = start + Math.floor((i / rows) * span) + Math.floor(random() * 600_000);
    const d = new Date(ms);
    const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    const u = random();
    const distance = Math.round(Math.min(60, -Math.log(1 - u * 0.999) * 3) * 100) / 100;
    const fare = Math.round((3 + distance * 2.5 + random() * 4) * 100) / 100;
    const p = random();
    const payment = PAYMENT_TYPES[p < 0.7 ? 0 : p < 0.92 ? 1 : p < 0.96 ? 2 : p < 0.98 ? 3 : 4];
    const passengers = random() < 0.02 ? '' : String(1 + Math.floor(random() ** 2 * 6));
    const location = 1 + Math.floor(random() ** 1.5 * 265);
    yield `${stamp},${distance},${fare},${payment},${passengers},${location}`;
  }
}

export const TAXI_LIKE_HEADER = 'pickup_datetime,trip_distance,fare_amount,payment_type,passenger_count,PULocationID';

export async function writeTaxiLikeCsv(path: string, rows: number, seed = 42): Promise<void> {
  await writeLines(path, TAXI_LIKE_HEADER, taxiLikeLines(rows, seed));
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
    const created = await QueryService.create(await testDriver(), { cacheDir, ...options, ...extra });
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

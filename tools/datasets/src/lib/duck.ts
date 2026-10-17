import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { copyCsvOptions, sqlString } from './common.ts';
import type { ColumnSpec } from './manifest.ts';

export interface DuckOptions {
  /** Spill directory for large sorts. */
  tempDirectory: string;
  /** Worker threads; omitted = DuckDB default (all cores). */
  threads?: number;
  /** e.g. "4GB"; omitted = DuckDB default (80% of RAM). */
  memoryLimit?: string;
}

export interface Duck {
  conn: DuckDBConnection;
  version: string;
  close(): void;
}

export async function openDuck(opts: DuckOptions): Promise<Duck> {
  const instance = await DuckDBInstance.create(':memory:');
  const conn = await instance.connect();
  await conn.run(`SET temp_directory = ${sqlString(opts.tempDirectory)}`);
  // Keep row order of ORDER BY results through COPY (the default, set explicitly).
  await conn.run('SET preserve_insertion_order = true');
  if (opts.threads !== undefined) await conn.run(`SET threads = ${Math.trunc(opts.threads)}`);
  if (opts.memoryLimit !== undefined) await conn.run(`SET memory_limit = ${sqlString(opts.memoryLimit)}`);
  const version = String((await conn.runAndReadAll('SELECT version() AS v')).getRowObjects()[0]?.['v']);
  return {
    conn,
    version,
    close() {
      conn.closeSync();
      instance.closeSync();
    },
  };
}

/** Column names and DuckDB types of a query's result, without running it. */
export async function describeQuery(conn: DuckDBConnection, query: string): Promise<ColumnSpec[]> {
  const reader = await conn.runAndReadAll(`DESCRIBE ${query}`);
  return reader.getRowObjects().map((r) => ({
    name: String(r['column_name']),
    type: String(r['column_type']),
  }));
}

/**
 * Writes `query` to `outPath` as CSV via COPY. Writes to a `.partial` file
 * first and renames it, so an interrupted run never leaves a plausible-looking
 * but truncated CSV behind.
 */
export async function copyToCsv(conn: DuckDBConnection, query: string, outPath: string): Promise<void> {
  const partial = `${outPath}.partial`;
  await rm(partial, { force: true });
  try {
    await conn.run(`COPY (${query}) TO ${sqlString(partial)} (${copyCsvOptions(true)})`);
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  }
  await rename(partial, outPath);
}

/**
 * Like copyToCsv, but runs one query per chunk and appends the chunks to a
 * single file (header from the first chunk only). Keeps each ORDER BY small,
 * so memory stays flat and large outputs avoid a spilling sort. The bytes are
 * the same as one COPY over the whole range as long as chunks are contiguous
 * and each one is ordered by the same key.
 */
export async function copyChunksToCsv(
  conn: DuckDBConnection,
  chunkQueries: readonly string[],
  outPath: string,
  onChunk?: (index: number) => void,
): Promise<void> {
  const partial = `${outPath}.partial`;
  const chunkFile = `${outPath}.chunk`;
  await rm(partial, { force: true });
  try {
    for (const [index, query] of chunkQueries.entries()) {
      await rm(chunkFile, { force: true });
      await conn.run(`COPY (${query}) TO ${sqlString(chunkFile)} (${copyCsvOptions(index === 0)})`);
      await pipeline(createReadStream(chunkFile), createWriteStream(partial, { flags: index === 0 ? 'w' : 'a' }));
      onChunk?.(index);
    }
  } catch (err) {
    await rm(partial, { force: true });
    throw err;
  } finally {
    await rm(chunkFile, { force: true });
  }
  await rename(partial, outPath);
}

import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { fixtureCsv } from '../src/testing/fixture';

/**
 * Sample datasets the page fetches over HTTP: a small fixture as CSV and as
 * Parquet (written by native DuckDB, read by DuckDB-WASM with the served
 * extension), and the bench files when asked for.
 */
export default async function globalSetup(): Promise<void> {
  const samples = resolve(import.meta.dirname, '.samples');
  await mkdir(samples, { recursive: true });
  const csv = join(samples, 'fixture-2000.csv');
  await writeFile(csv, fixtureCsv(2000));
  const parquet = join(samples, 'fixture-2000.parquet');
  await rm(parquet, { force: true });
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(`COPY (FROM read_csv('${csv.replaceAll("'", "''")}')) TO '${parquet.replaceAll("'", "''")}' (FORMAT parquet, COMPRESSION zstd)`);
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  for (const variable of ['GLASSGRID_M4_BENCH_CSV', 'GLASSGRID_M4_BENCH_PARQUET']) {
    const path = process.env[variable];
    if (path) await copyFile(resolve(path), join(samples, basename(path)));
  }
}

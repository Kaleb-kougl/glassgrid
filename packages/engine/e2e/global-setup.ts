import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fixtureCsv } from '../src/testing/fixture';

/** Sample datasets the page fetches over HTTP: a small fixture, and the bench files when asked for. */
export default async function globalSetup(): Promise<void> {
  const samples = resolve(import.meta.dirname, '.samples');
  await mkdir(samples, { recursive: true });
  await writeFile(join(samples, 'fixture-2000.csv'), fixtureCsv(2000));
  for (const variable of ['GLASSGRID_M4_BENCH_CSV', 'GLASSGRID_M4_BENCH_PARQUET']) {
    const path = process.env[variable];
    if (path) await copyFile(resolve(path), join(samples, basename(path)));
  }
}

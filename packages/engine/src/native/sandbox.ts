import { mkdir, rm } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DatabaseOptions } from '../driver';
import { quoteLiteral } from '../sql-text';

/*
 * DuckDB instances with external access locked down (docs/m2-engine-notes.md,
 * "Security").
 *
 * DuckDB only lets `allowed_paths` / `allowed_directories` change while
 * `enable_external_access` is still on, and `lock_configuration` freezes
 * every setting after that. A single shared instance could therefore never
 * learn about files the user opens later. Instead each open table gets its
 * own instance whose allowlist is fixed at creation: the one file it reads
 * plus the Parquet cache folder. Everything else (other paths, globs, URLs,
 * extension installs, COPY to elsewhere, SET/RESET of any option) fails
 * with a Permission or Invalid Input error, even for SQL the engine did not
 * write.
 */

/** `tempDirectory` must be private to the instance: DuckDB's temp file names are fixed. */
export type SandboxOptions = DatabaseOptions;

/** Default per-instance memory limit: half of physical memory, at least 512 MB. */
export function defaultMemoryLimitBytes(): number {
  return Math.max(512 * 1024 * 1024, Math.floor(totalmem() * 0.5));
}

function listLiteral(values: readonly string[]): string {
  return `[${values.map(quoteLiteral).join(', ')}]`;
}

export async function createSandboxedInstance(options: SandboxOptions): Promise<DuckDBInstance> {
  // DuckDB creates the spill folder itself but not its parents.
  await mkdir(options.tempDirectory, { recursive: true });
  const db = await DuckDBInstance.create(':memory:', {
    // An offline desktop app must never fetch or load extensions behind the user's back.
    autoinstall_known_extensions: 'false',
    autoload_known_extensions: 'false',
    // Unsorted pages and file-order tie-breaks rely on scans keeping file order.
    preserve_insertion_order: 'true',
    temp_directory: options.tempDirectory,
    memory_limit: `${Math.floor(options.memoryLimitBytes / (1024 * 1024))}MB`,
  });
  try {
    const connection = await db.connect();
    try {
      await connection.run(`SET allowed_paths = ${listLiteral(options.allowedPaths)}`);
      await connection.run(`SET allowed_directories = ${listLiteral(options.allowedDirectories)}`);
      await connection.run('SET enable_external_access = false');
      await connection.run('SET lock_configuration = true');
    } finally {
      connection.closeSync();
    }
  } catch (error) {
    db.closeSync();
    throw error;
  }
  return db;
}

/** Remove an instance's spill folder after the instance is closed. */
export async function removeTempDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true }).catch(() => undefined);
}

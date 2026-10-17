import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Package root (the folder holding package.json), independent of the cwd. */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Default output folder (gitignored). */
export const DEFAULT_OUT_DIR = path.join(PACKAGE_ROOT, 'out');

/** Bump when the CSV a recipe produces would change for the same inputs. */
export const PACKAGE_VERSION = '0.1.0';

/** CSV dialect shared by every dataset. Recorded verbatim in each manifest. */
export const CSV_FORMAT = {
  encoding: 'utf-8',
  delimiter: ',',
  quote: '"',
  escape: '"',
  header: true,
  newline: '\n',
  nullString: '',
  timestampFormat: '%Y-%m-%d %H:%M:%S',
  decimalSeparator: '.',
} as const;

/** The DuckDB COPY options that implement CSV_FORMAT. */
export function copyCsvOptions(header = true): string {
  return (
    `FORMAT csv, HEADER ${header}, DELIMITER ',', QUOTE '"', ESCAPE '"', NULLSTR '', ` +
    `TIMESTAMPFORMAT '${CSV_FORMAT.timestampFormat}'`
  );
}

/**
 * Parses a row count such as `1000000`, `1_000_000`, `1m`, `10M`, `500k`.
 * Throws on anything that is not a positive integer.
 */
export function parseRows(input: string): number {
  const s = input.trim().toLowerCase().replaceAll('_', '').replaceAll(',', '');
  const m = /^(\d+(?:\.\d+)?)([km]?)$/.exec(s);
  if (!m) throw new Error(`Invalid row count: "${input}"`);
  const mult = m[2] === 'm' ? 1_000_000 : m[2] === 'k' ? 1_000 : 1;
  const n = Number(m[1]) * mult;
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`Invalid row count: "${input}"`);
  return n;
}

/** 10000000 -> "10m", 1500 -> "1500". Used in output file names. */
export function rowsLabel(n: number): string {
  if (n % 1_000_000 === 0) return `${n / 1_000_000}m`;
  if (n % 1_000 === 0) return `${n / 1_000}k`;
  return String(n);
}

export async function ensureDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Escapes a value for use inside a single-quoted SQL string literal. */
export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function log(message: string): void {
  process.stderr.write(`[datasets] ${message}\n`);
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function seconds(sinceMs: number): number {
  return Math.round((performance.now() - sinceMs) / 10) / 100;
}

/** Runs `main`, printing a readable error and exiting non-zero on failure. */
export function runCli(main: () => Promise<void>): void {
  main().catch((err: unknown) => {
    process.stderr.write(`[datasets] error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}

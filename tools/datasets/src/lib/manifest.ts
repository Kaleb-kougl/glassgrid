import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type CSV_FORMAT, PACKAGE_ROOT, PACKAGE_VERSION } from './common.ts';

export const MANIFEST_VERSION = 1;

export interface ColumnSpec {
  name: string;
  /** DuckDB logical type of the column before it was written as text. */
  type: string;
  description?: string;
}

export interface SourceFile {
  month: string;
  url: string;
  bytes: number;
  sha256: string;
  /** Row count from the Parquet footer. */
  rows: number;
}

export interface Manifest {
  manifestVersion: number;
  /** Dataset family: "nyc-taxi-yellow" or "synthetic". */
  dataset: string;
  /** Unique name, also the CSV base name, e.g. "nyc-taxi-yellow-10m". */
  name: string;
  /** CSV file name, relative to the manifest's folder. */
  file: string;
  /** Data rows, excluding the header row. */
  rows: number;
  bytes: number;
  sha256: string;
  columns: ColumnSpec[];
  format: typeof CSV_FORMAT;
  generator: {
    package: string;
    packageVersion: string;
    /** Recipe id + version; bump the version when its output changes. */
    recipe: string;
    duckdbVersion: string;
    nodeVersion: string;
  };
  /** Synthetic only. */
  seed?: number;
  /** Taxi only. */
  source?: {
    provider: string;
    page: string;
    dataDictionary: string;
    terms: string[];
    months: string[];
    files: SourceFile[];
  };
  /** The exact SQL whose result was written. */
  query: string;
  generatedAt: string;
  elapsedSeconds: number;
}

export interface CsvStats {
  bytes: number;
  sha256: string;
  /** Data rows (records minus the header), counted quote-aware. */
  rows: number;
}

/**
 * One streaming pass: SHA-256 of the file plus a quote-aware record count
 * (RFC 4180: a newline inside a double-quoted field does not end a record;
 * an escaped quote `""` toggles the state twice, so it is neutral).
 */
export async function csvStats(file: string): Promise<CsvStats> {
  const hash = createHash('sha256');
  let bytes = 0;
  let newlines = 0;
  let inQuotes = false;
  let last = -1;
  const QUOTE = 0x22;
  const LF = 0x0a;
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 }) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.length;
    if (!inQuotes && !chunk.includes(QUOTE)) {
      // Fast path: no quotes in this chunk, count newlines with indexOf.
      let i = chunk.indexOf(LF);
      while (i !== -1) {
        newlines++;
        i = chunk.indexOf(LF, i + 1);
      }
    } else {
      for (let i = 0; i < chunk.length; i++) {
        const b = chunk[i];
        if (b === QUOTE) inQuotes = !inQuotes;
        else if (b === LF && !inQuotes) newlines++;
      }
    }
    if (chunk.length > 0) last = chunk[chunk.length - 1] ?? -1;
  }
  const records = newlines + (bytes > 0 && last !== LF ? 1 : 0);
  return { bytes, sha256: hash.digest('hex'), rows: Math.max(0, records - 1) };
}

export function manifestPathFor(csvPath: string): string {
  return csvPath.replace(/\.csv$/i, '') + '.manifest.json';
}

export async function writeManifest(csvPath: string, manifest: Manifest): Promise<string> {
  const out = manifestPathFor(csvPath);
  await writeFile(out, JSON.stringify(manifest, null, 2) + '\n');
  return out;
}

export async function readManifest(manifestPath: string): Promise<Manifest> {
  const m = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  if (m.manifestVersion !== MANIFEST_VERSION) {
    throw new Error(`${manifestPath}: unsupported manifestVersion ${String(m.manifestVersion)}`);
  }
  return m;
}

export function generatorInfo(recipe: string, duckdbVersion: string): Manifest['generator'] {
  return {
    package: '@glassgrid/datasets',
    packageVersion: PACKAGE_VERSION,
    recipe,
    duckdbVersion,
    nodeVersion: process.version,
  };
}

export interface Pin {
  rows: number;
  sha256: string;
  recipe: string;
  duckdbVersion: string;
}

/** Reference hashes checked into pins.json, keyed by dataset name. */
export async function readPins(): Promise<Record<string, Pin>> {
  try {
    const raw = JSON.parse(await readFile(path.join(PACKAGE_ROOT, 'pins.json'), 'utf8')) as { datasets?: Record<string, Pin> };
    return raw.datasets ?? {};
  } catch {
    return {};
  }
}

export interface VerifyResult {
  manifestPath: string;
  csvPath: string;
  ok: boolean;
  problems: string[];
  /** Comparison with pins.json, if it has an entry for this dataset. */
  pin: 'match' | 'mismatch' | 'not-comparable' | 'none';
  notes: string[];
  actual: CsvStats;
}

export async function verifyManifest(manifestPath: string): Promise<VerifyResult> {
  const m = await readManifest(manifestPath);
  const csvPath = path.resolve(path.dirname(manifestPath), m.file);
  await stat(csvPath); // throws a clear ENOENT if the CSV is missing
  const actual = await csvStats(csvPath);
  const problems: string[] = [];
  if (actual.rows !== m.rows) problems.push(`rows: manifest ${m.rows}, file ${actual.rows}`);
  if (actual.bytes !== m.bytes) problems.push(`bytes: manifest ${m.bytes}, file ${actual.bytes}`);
  if (actual.sha256 !== m.sha256) problems.push(`sha256: manifest ${m.sha256}, file ${actual.sha256}`);

  const notes: string[] = [];
  let pinState: VerifyResult['pin'] = 'none';
  const pin = (await readPins())[m.name];
  if (pin) {
    if (pin.recipe !== m.generator.recipe || pin.duckdbVersion !== m.generator.duckdbVersion) {
      pinState = 'not-comparable';
      notes.push(
        `pins.json entry is for ${pin.recipe} on DuckDB ${pin.duckdbVersion}; this file is ${m.generator.recipe} on DuckDB ${m.generator.duckdbVersion}`,
      );
    } else if (pin.rows === actual.rows && pin.sha256 === actual.sha256) {
      pinState = 'match';
    } else {
      pinState = 'mismatch';
      problems.push(`differs from pins.json reference (sha256 ${pin.sha256}, ${pin.rows} rows)`);
      if (m.source) notes.push('if TLC re-published a source month, compare source.files[].sha256 with a previous manifest');
    }
  }
  return { manifestPath, csvPath, ok: problems.length === 0, problems, pin: pinState, notes, actual };
}

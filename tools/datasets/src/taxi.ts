/**
 * NYC TLC Yellow Taxi benchmark CSV.
 *
 *   npm run taxi                      # 10,000,000 rows (2024-03..2024-05)
 *   npm run taxi -- --rows 1000000    # 1,000,000 rows (2024-03 only)
 *
 * Downloads the monthly Parquet files (cached in out/cache/), reads them with
 * DuckDB, sorts by a total order over every column and writes exactly --rows
 * rows to ONE CSV plus a manifest.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  CSV_FORMAT,
  DEFAULT_OUT_DIR,
  ensureDir,
  formatBytes,
  log,
  parseRows,
  rowsLabel,
  runCli,
  seconds,
  sqlString,
} from './lib/common.ts';
import { fetchCached, type CachedFile } from './lib/download.ts';
import { copyToCsv, describeQuery, openDuck } from './lib/duck.ts';
import { csvStats, generatorInfo, writeManifest, type ColumnSpec, type SourceFile } from './lib/manifest.ts';

/** Bump when the output for the same months and row count would change. */
const RECIPE = 'nyc-taxi-yellow/1';

const TLC_PAGE = 'https://www.nyc.gov/site/tlc/about/tlc-trip-record-data.page';
const TLC_DATA_DICTIONARY = 'https://www.nyc.gov/assets/tlc/downloads/pdf/data_dictionary_trip_records_yellow.pdf';
const TLC_BASE_URL = 'https://d37ci6vzurychx.cloudfront.net/trip-data';
const TERMS = [
  'https://www.nyc.gov/html/data/terms.html',
  'https://intro.nyc/local-laws/2012-11',
];

/**
 * Months are taken in this order until their Parquet row counts cover --rows.
 * 2024-03 + 2024-04 + 2024-05 ≈ 10.8M rows, so the 10M dataset uses those
 * three; 2024-06 is a spare for larger requests. All are 2024 files, which
 * share one 19-column schema (cbd_congestion_fee only exists from 2025).
 */
const DEFAULT_MONTHS = ['2024-03', '2024-04', '2024-05', '2024-06'] as const;

/**
 * Fixed output columns, in order: data dictionary fields 1-19 with the types
 * TLC uses in the 2024 Parquet files. Explicit casts keep the CSV identical
 * if TLC widens a type (e.g. INTEGER -> BIGINT) in a future re-publish.
 */
const COLUMNS: readonly { name: string; source: string; type: string; description: string }[] = [
  { name: 'VendorID', source: 'VendorID', type: 'INTEGER', description: 'TPEP provider code' },
  { name: 'tpep_pickup_datetime', source: 'tpep_pickup_datetime', type: 'TIMESTAMP', description: 'Meter engaged' },
  { name: 'tpep_dropoff_datetime', source: 'tpep_dropoff_datetime', type: 'TIMESTAMP', description: 'Meter disengaged' },
  { name: 'passenger_count', source: 'passenger_count', type: 'BIGINT', description: 'Passengers (driver-entered, nullable)' },
  { name: 'trip_distance', source: 'trip_distance', type: 'DOUBLE', description: 'Miles, from the taximeter' },
  { name: 'RatecodeID', source: 'RatecodeID', type: 'BIGINT', description: 'Final rate code (nullable)' },
  { name: 'store_and_fwd_flag', source: 'store_and_fwd_flag', type: 'VARCHAR', description: 'Y/N store-and-forward (nullable)' },
  { name: 'PULocationID', source: 'PULocationID', type: 'INTEGER', description: 'Pickup TLC Taxi Zone' },
  { name: 'DOLocationID', source: 'DOLocationID', type: 'INTEGER', description: 'Drop-off TLC Taxi Zone' },
  { name: 'payment_type', source: 'payment_type', type: 'BIGINT', description: 'Payment type code' },
  { name: 'fare_amount', source: 'fare_amount', type: 'DOUBLE', description: 'Time-and-distance fare (USD)' },
  { name: 'extra', source: 'extra', type: 'DOUBLE', description: 'Misc extras and surcharges (USD)' },
  { name: 'mta_tax', source: 'mta_tax', type: 'DOUBLE', description: 'MTA tax (USD)' },
  { name: 'tip_amount', source: 'tip_amount', type: 'DOUBLE', description: 'Tip, card tips only (USD)' },
  { name: 'tolls_amount', source: 'tolls_amount', type: 'DOUBLE', description: 'Tolls (USD)' },
  { name: 'improvement_surcharge', source: 'improvement_surcharge', type: 'DOUBLE', description: 'Improvement surcharge (USD)' },
  { name: 'total_amount', source: 'total_amount', type: 'DOUBLE', description: 'Total charged, excl. cash tips (USD)' },
  { name: 'congestion_surcharge', source: 'congestion_surcharge', type: 'DOUBLE', description: 'NYS congestion surcharge (USD, nullable)' },
  // Spelled "Airport_fee" in the 2024 Parquet files; DuckDB binds names case-insensitively.
  { name: 'airport_fee', source: 'airport_fee', type: 'DOUBLE', description: 'JFK/LGA pickup fee (USD, nullable)' },
];

/** Sort keys: a total order over every column, so ties are byte-identical rows. */
const ORDER_KEYS = [
  'tpep_pickup_datetime',
  'tpep_dropoff_datetime',
  'VendorID',
  'PULocationID',
  'DOLocationID',
  ...COLUMNS.map((c) => c.name).filter(
    (n) => !['tpep_pickup_datetime', 'tpep_dropoff_datetime', 'VendorID', 'PULocationID', 'DOLocationID'].includes(n),
  ),
];

function monthUrl(baseUrl: string, month: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/yellow_tripdata_${month}.parquet`;
}

function parseMonths(value: string): string[] {
  const months = value.split(',').map((m) => m.trim()).filter(Boolean);
  for (const m of months) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new Error(`Invalid month "${m}" (expected YYYY-MM)`);
  }
  if (months.length === 0) throw new Error('--months is empty');
  return months;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      rows: { type: 'string', default: '10000000' },
      months: { type: 'string' },
      out: { type: 'string', default: DEFAULT_OUT_DIR },
      name: { type: 'string' },
      'base-url': { type: 'string', default: process.env['GLASSGRID_TLC_BASE_URL'] ?? TLC_BASE_URL },
      'prune-cache': { type: 'boolean', default: false },
      'memory-limit': { type: 'string' },
      threads: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(
      [
        'Usage: npm run taxi -- [--rows 10000000] [--months 2024-03,2024-04,...] [--out out]',
        '                       [--name NAME] [--base-url URL] [--prune-cache] [--memory-limit 4GB] [--threads N]',
        '',
        '--months is an ordered candidate list; months are used from the start until they cover --rows.',
        `Default months (taken in order until they cover --rows): ${DEFAULT_MONTHS.join(', ')}`,
        `Default base URL: ${TLC_BASE_URL} (env GLASSGRID_TLC_BASE_URL overrides)`,
        '',
      ].join('\n'),
    );
    return;
  }

  const rows = parseRows(values.rows);
  const outDir = await ensureDir(path.resolve(values.out));
  const cacheDir = path.join(outDir, 'cache');
  const name = values.name ?? `nyc-taxi-yellow-${rowsLabel(rows)}`;
  const csvPath = path.join(outDir, `${name}.csv`);
  const candidates = values.months !== undefined ? parseMonths(values.months) : [...DEFAULT_MONTHS];
  const baseUrl = values['base-url'];

  const t0 = performance.now();
  const duck = await openDuck({
    tempDirectory: await ensureDir(path.join(cacheDir, 'duckdb-tmp')),
    ...(values['memory-limit'] !== undefined ? { memoryLimit: values['memory-limit'] } : {}),
    ...(values.threads !== undefined ? { threads: Number(values.threads) } : {}),
  });
  const { conn } = duck;
  try {
    // 1. Fetch candidate months in order, stopping once their rows cover the request.
    const sources: { month: string; file: CachedFile; rows: number }[] = [];
    let available = 0;
    for (const month of candidates) {
      if (available >= rows) break;
      const file = await fetchCached(monthUrl(baseUrl, month), cacheDir);
      const meta = await conn.runAndReadAll(
        `SELECT sum(num_rows)::BIGINT AS n FROM parquet_file_metadata(${sqlString(file.path)})`,
      );
      const n = Number(meta.getRowObjects()[0]?.['n'] ?? 0);
      sources.push({ month, file, rows: n });
      available += n;
      log(`${month}: ${n.toLocaleString('en-US')} rows (${formatBytes(file.bytes)}${file.fromCache ? ', cached' : ''})`);
    }
    if (available < rows) {
      throw new Error(
        `Months ${sources.map((s) => s.month).join(', ')} hold ${available} rows; ${rows} requested. Add months via --months.`,
      );
    }

    // 2. Fixed columns, total order, exact row count.
    const fileList = `[${sources.map((s) => sqlString(s.file.path)).join(', ')}]`;
    const select = COLUMNS.map((c) => `CAST("${c.source}" AS ${c.type}) AS "${c.name}"`).join(',\n  ');
    const orderBy = ORDER_KEYS.map((k) => `"${k}" ASC NULLS LAST`).join(', ');
    const fromClause = `read_parquet(${fileList}, union_by_name = true)`;
    const query = `SELECT\n  ${select}\nFROM ${fromClause}\nORDER BY ${orderBy}\nLIMIT ${rows}`;

    const described = await describeQuery(conn, query);
    const columns: ColumnSpec[] = described.map((c) => ({
      ...c,
      description: COLUMNS.find((x) => x.name === c.name)?.description ?? '',
    }));

    log(`writing ${rows.toLocaleString('en-US')} rows -> ${path.relative(process.cwd(), csvPath)}`);
    const tCopy = performance.now();
    await copyToCsv(conn, query, csvPath);
    log(`  COPY took ${seconds(tCopy)} s`);

    // 3. Manifest (the query is recorded with portable file names, not local cache paths).
    const stats = await csvStats(csvPath);
    if (stats.rows !== rows) throw new Error(`Wrote ${stats.rows} rows, expected ${rows}`);
    const sourceFiles: SourceFile[] = sources.map((s) => ({
      month: s.month,
      url: s.file.url,
      bytes: s.file.bytes,
      sha256: s.file.sha256,
      rows: s.rows,
    }));
    const portableQuery = query.replace(
      fileList,
      `[${sources.map((s) => sqlString(`yellow_tripdata_${s.month}.parquet`)).join(', ')}]`,
    );
    const manifestPath = await writeManifest(csvPath, {
      manifestVersion: 1,
      dataset: 'nyc-taxi-yellow',
      name,
      file: path.basename(csvPath),
      rows: stats.rows,
      bytes: stats.bytes,
      sha256: stats.sha256,
      columns,
      format: CSV_FORMAT,
      generator: generatorInfo(RECIPE, duck.version),
      source: {
        provider: 'NYC Taxi & Limousine Commission (TLC), TPEP trip records',
        page: TLC_PAGE,
        dataDictionary: TLC_DATA_DICTIONARY,
        terms: TERMS,
        months: sources.map((s) => s.month),
        files: sourceFiles,
      },
      query: portableQuery,
      generatedAt: new Date().toISOString(),
      elapsedSeconds: seconds(t0),
    });
    log(`done: ${stats.rows.toLocaleString('en-US')} rows, ${formatBytes(stats.bytes)}, sha256 ${stats.sha256}`);
    log(`manifest: ${path.relative(process.cwd(), manifestPath)}`);

    if (values['prune-cache']) {
      for (const s of sources) {
        await rm(s.file.path, { force: true });
        await rm(`${s.file.path}.meta.json`, { force: true });
      }
      log('pruned downloaded Parquet from the cache');
    }
  } finally {
    duck.close();
    await rm(path.join(cacheDir, 'duckdb-tmp'), { recursive: true, force: true });
  }
}

runCli(main);

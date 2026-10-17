/**
 * Seeded synthetic benchmark CSV.
 *
 *   npm run synthetic -- --rows 1m  --seed 42
 *   npm run synthetic -- --rows 10m --seed 42
 *   npm run synthetic -- --rows 50m --seed 42
 *
 * Determinism: every value is a pure function of (seed, row index, column
 * salt) built from DuckDB's hash() plus integer arithmetic. No random(), no
 * transcendental math (exp/ln/cos can differ by an ulp between libm builds).
 * Generation can therefore run on all cores and the same seed + row count +
 * recipe version + DuckDB version gives a byte-identical CSV.
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
import { copyChunksToCsv, describeQuery, openDuck } from './lib/duck.ts';
import { csvStats, generatorInfo, writeManifest, type ColumnSpec } from './lib/manifest.ts';

/** Bump when the CSV for the same seed and row count would change. */
const RECIPE = 'synthetic/1';

const REGIONS = ['us-east', 'eu-west', 'us-west', 'ap-south', 'eu-central', 'ap-northeast', 'sa-east', 'af-south'];

/** Comment vocabulary. Includes a comma, quotes and non-ASCII to exercise CSV quoting and UTF-8. */
const WORDS = [
  'delivered', 'late', 'on', 'time', 'great', 'service', 'package', 'damaged', 'refund', 'requested',
  'customer', 'called', 'twice', 'box', 'was', 'open', 'left', 'at', 'the', 'door', '"fragile"', 'label',
  'missing', 'item,', 'wrong', 'size', 'colour', 'faded', 'works', 'perfectly', 'will', 'order', 'again',
  'driver', 'very', 'polite', 'slow', 'shipping', 'fast', 'checkout', 'issue', 'resolved', 'support',
  'ticket', '#4521', '—', 'café', 'naïve', '5/5', '📦',
];

const DESCRIPTIONS: Record<string, string> = {
  id: 'Row number, 1..N (unique, sorted)',
  event_time: 'Timestamp from 2024-01-01, ~2 s apart with jitter (locally out of order)',
  region: `Low cardinality (${REGIONS.length} values), skewed`,
  status: 'Low cardinality (4 values): completed 70%, pending 15%, refunded 10%, failed 5%',
  customer_id: 'High cardinality string, up to 2,000,000 distinct values',
  session_id: '16 hex chars, effectively unique per row',
  quantity: 'Integer 1..20, geometric-like',
  unit_price: 'DECIMAL(10,2), 0.99..2000.79, skewed toward small values',
  amount: 'DECIMAL(14,2) = quantity * unit_price',
  discount_pct: 'Nullable float 0.0..40.0 (NULL ~35%, written as an empty field)',
  latitude: 'Float, NYC bounding box, 6 decimals',
  longitude: 'Float, NYC bounding box, 6 decimals',
  is_returning: 'Boolean, true ~40%',
  comment: 'Free text, 1-12 words (NULL ~8%); contains commas, quotes, non-ASCII',
};

/** Rows [start, end) of the dataset, ordered by id. */
function buildQuery(start: number, end: number, seed: number): { macros: string[]; query: string } {
  const list = (xs: string[]) => `[${xs.map(sqlString).join(', ')}]`;
  const macros = [
    // 64-bit hash of (row, seed, column salt).
    `CREATE OR REPLACE TEMP MACRO h(i, k) AS hash(i::BIGINT, ${seed}::BIGINT, k::INTEGER)`,
    // Integer in [0, n). Modulo bias is irrelevant for n << 2^64.
    `CREATE OR REPLACE TEMP MACRO pick(i, k, n) AS (h(i, k) % n::UBIGINT)::BIGINT`,
  ];
  const nRegions = REGIONS.length;
  const nWords = WORDS.length;
  const query = `SELECT
  id, event_time, region, status, customer_id, session_id, quantity, unit_price,
  CAST(quantity * unit_price AS DECIMAL(14,2)) AS amount,
  discount_pct, latitude, longitude, is_returning, comment
FROM (
  SELECT
    i + 1 AS id,
    make_timestamp((1704067200 + i * 2 + pick(i, 1, 5)) * 1000000) AS event_time,
    ${list(REGIONS)}[1 + (pick(i, 2, 1000) * pick(i, 2, 1000)) * ${nRegions} // 1000000] AS region,
    CASE WHEN pick(i, 3, 100) < 70 THEN 'completed'
         WHEN pick(i, 3, 100) < 85 THEN 'pending'
         WHEN pick(i, 3, 100) < 95 THEN 'refunded'
         ELSE 'failed' END AS status,
    'C' || lpad(CAST(pick(i, 4, 2000000) AS VARCHAR), 7, '0') AS customer_id,
    printf('%016x', h(i, 5)) AS session_id,
    CAST(CASE WHEN pick(i, 6, 1000) < 500 THEN 1
              WHEN pick(i, 6, 1000) < 750 THEN 2
              WHEN pick(i, 6, 1000) < 875 THEN 3
              WHEN pick(i, 6, 1000) < 940 THEN 4
              WHEN pick(i, 6, 1000) < 970 THEN 5
              ELSE 6 + (pick(i, 6, 1000) - 970) // 2 END AS INTEGER) AS quantity,
    -- Integer cents scaled exactly by a DECIMAL literal (no binary floating point).
    CAST(CAST(99 + pick(i, 7, 20000) * pick(i, 7, 20000) // 2000 AS DECIMAL(12,0)) * 0.01 AS DECIMAL(10,2)) AS unit_price,
    CASE WHEN pick(i, 9, 100) < 35 THEN NULL
         ELSE CAST(pick(i, 10, 401) AS DOUBLE) / 10 END AS discount_pct,
    CAST(40477400 + pick(i, 11, 438700) AS DOUBLE) / 1000000 AS latitude,
    CAST(-74259100 + pick(i, 12, 559000) AS DOUBLE) / 1000000 AS longitude,
    pick(i, 13, 100) < 40 AS is_returning,
    CASE WHEN pick(i, 14, 100) < 8 THEN NULL
         ELSE array_to_string(
           list_transform(range(1 + pick(i, 15, 12)),
             lambda k: ${list(WORDS)}[1 + pick(i, 1000 + k, ${nWords})]),
           ' ') END AS comment
  FROM range(${start}, ${end}) AS t(i)
)
ORDER BY id`;
  return { macros, query };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      rows: { type: 'string', default: '1000000' },
      seed: { type: 'string', default: '42' },
      out: { type: 'string', default: DEFAULT_OUT_DIR },
      name: { type: 'string' },
      threads: { type: 'string' },
      'chunk-rows': { type: 'string', default: '1000000' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write('Usage: npm run synthetic -- [--rows 1m|10m|50m|N] [--seed 42] [--out out] [--name NAME] [--threads N] [--chunk-rows 1m]\n');
    return;
  }
  const rows = parseRows(values.rows);
  const chunkRows = parseRows(values['chunk-rows']);
  const seed = Number(values.seed);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error(`--seed must be a non-negative integer, got "${values.seed}"`);
  const outDir = await ensureDir(path.resolve(values.out));
  const name = values.name ?? `synthetic-${rowsLabel(rows)}-seed${seed}`;
  const csvPath = path.join(outDir, `${name}.csv`);

  const t0 = performance.now();
  const tmp = await ensureDir(path.join(outDir, 'cache', 'duckdb-tmp'));
  const duck = await openDuck({
    tempDirectory: tmp,
    ...(values.threads !== undefined ? { threads: Number(values.threads) } : {}),
  });
  try {
    const { macros, query } = buildQuery(0, rows, seed);
    for (const m of macros) await duck.conn.run(m);
    // Generate in contiguous id ranges. Each value depends only on (seed, row), so
    // the chunk size changes speed and memory, never the bytes written.
    const chunkQueries: string[] = [];
    for (let start = 0; start < rows; start += chunkRows) {
      chunkQueries.push(buildQuery(start, Math.min(rows, start + chunkRows), seed).query);
    }
    const columns: ColumnSpec[] = (await describeQuery(duck.conn, query)).map((c) => ({
      ...c,
      description: DESCRIPTIONS[c.name] ?? '',
    }));

    log(`writing ${rows.toLocaleString('en-US')} rows (seed ${seed}) -> ${path.relative(process.cwd(), csvPath)}`);
    const tCopy = performance.now();
    await copyChunksToCsv(duck.conn, chunkQueries, csvPath, (i) => {
      if (chunkQueries.length > 1 && (i + 1) % 5 === 0) log(`  ${(i + 1) * chunkRows} / ${rows} rows`);
    });
    log(`  COPY took ${seconds(tCopy)} s`);

    const stats = await csvStats(csvPath);
    if (stats.rows !== rows) throw new Error(`Wrote ${stats.rows} rows, expected ${rows}`);
    const manifestPath = await writeManifest(csvPath, {
      manifestVersion: 1,
      dataset: 'synthetic',
      name,
      file: path.basename(csvPath),
      rows: stats.rows,
      bytes: stats.bytes,
      sha256: stats.sha256,
      columns,
      format: CSV_FORMAT,
      generator: generatorInfo(RECIPE, duck.version),
      seed,
      query: [...macros.map((m) => `${m};`), `${query};`].join('\n'),
      generatedAt: new Date().toISOString(),
      elapsedSeconds: seconds(t0),
    });
    log(`done: ${stats.rows.toLocaleString('en-US')} rows, ${formatBytes(stats.bytes)}, sha256 ${stats.sha256}`);
    log(`manifest: ${path.relative(process.cwd(), manifestPath)}`);
  } finally {
    duck.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

runCli(main);

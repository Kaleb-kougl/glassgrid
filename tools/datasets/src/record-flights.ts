/**
 * Records live Bay Area traffic from adsb.lol into the same Parquet layout
 * as the archive fixtures (`globe-history`), with `source = 'live'`.
 *
 *   pnpm --filter @glassgrid/datasets record-flights                      # 30 minutes, every 10 s
 *   pnpm --filter @glassgrid/datasets record-flights -- --minutes 5 --out DIR --raw responses.ndjson
 *
 * Polls the point endpoint around the centre of `BAY_AREA_BBOX` with a
 * radius that covers the box (`lib/adsblol.ts`; the URL there is not yet
 * verified against adsb.lol's API docs), maps each aircraft with
 * `fromReadsbAircraft`, keeps fixes inside the box, drops repeated
 * (hex, ts) fixes, and writes `flights-live-<start>.parquet` plus a
 * manifest. Rate limits (429) and server errors back off and carry on.
 * `--raw` keeps every response as one JSON line, to check field units
 * against the docs. Behind a proxy set NODE_USE_ENV_PROXY=1.
 *
 * The data is adsb.lol's, under the ODbL 1.0: keep the attribution in the
 * manifest with any file you share.
 */
import { appendFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BAY_AREA_BBOX } from '@glassgrid/core';
import { cliArgs, DEFAULT_OUT_DIR, ensureDir, formatBytes, log, PACKAGE_ROOT, runCli, seconds } from './lib/common.ts';
import { ADSBLOL_API_BASE, adsbLolBboxUrl, recordLive } from './lib/adsblol.ts';
import { openDuck } from './lib/duck.ts';
import { appendFlightPoints, createFlightTable, FLIGHT_PARQUET_OPTIONS, FLIGHT_PRECISION, writeFlightParquet } from './lib/flights.ts';
import { generatorInfo } from './lib/manifest.ts';

const RECIPE = 'flights-live/1';

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: cliArgs(),
    options: {
      minutes: { type: 'string', default: '30' },
      interval: { type: 'string', default: '10' },
      out: { type: 'string', default: path.join(DEFAULT_OUT_DIR, 'flights') },
      'base-url': { type: 'string', default: process.env['GLASSGRID_ADSBLOL_BASE_URL'] ?? ADSBLOL_API_BASE },
      raw: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write('Usage: pnpm --filter @glassgrid/datasets record-flights [-- --minutes 30 --interval 10 --out DIR --base-url URL --raw FILE]\n');
    return;
  }
  const minutes = Number(values.minutes);
  const intervalSec = Number(values.interval);
  if (!(minutes > 0) || !(intervalSec >= 1)) throw new Error('--minutes must be > 0 and --interval >= 1 (seconds)');
  const outDir = await ensureDir(path.resolve(values.out));
  const url = adsbLolBboxUrl(BAY_AREA_BBOX, values['base-url']);
  const rawFile = values.raw === undefined ? null : path.resolve(values.raw);
  if (rawFile) await writeFile(rawFile, '');
  const t0 = performance.now();
  log(`recording ${url} every ${intervalSec} s for ${minutes} min`);

  const result = await recordLive({
    url,
    bbox: BAY_AREA_BBOX,
    durationMs: minutes * 60_000,
    intervalMs: intervalSec * 1000,
    log,
    ...(rawFile ? { onResponse: (json: unknown, atMs: number) => appendFileSync(rawFile, `${JSON.stringify({ atMs, response: json })}\n`) } : {}),
  });
  log(`${result.polls} polls (${result.okPolls} ok, ${result.errors.length} failed), ${result.points.length.toLocaleString('en-US')} fixes`);
  if (result.points.length === 0) throw new Error('no fixes recorded');

  const stamp = new Date(result.startedAtMs).toISOString().replace(/[:]/g, '').replace(/\.\d+Z$/, 'Z');
  const fileName = `flights-live-${stamp}.parquet`;
  const tmp = await ensureDir(path.join(PACKAGE_ROOT, 'out', 'cache', 'duckdb-tmp-live'));
  const duck = await openDuck({ tempDirectory: tmp, threads: 1 });
  try {
    await createFlightTable(duck.conn, 'points');
    const appender = await duck.conn.createAppender('points');
    appendFlightPoints(appender, result.points);
    appender.flushSync();
    appender.closeSync();
    const written = await writeFlightParquet(duck.conn, 'points', path.join(outDir, fileName));
    const manifest = {
      manifestVersion: 1,
      dataset: 'flights-live',
      recipe: RECIPE,
      generator: generatorInfo(RECIPE, duck.version),
      licence: {
        id: 'ODbL-1.0',
        url: 'https://opendatacommons.org/licenses/odbl/1.0/',
        attribution: 'Data © adsb.lol contributors, licensed under the Open Database License (ODbL) 1.0',
      },
      source: { provider: 'adsb.lol', endpoint: url, endpointVerified: false, intervalSeconds: intervalSec },
      area: { name: 'San Francisco Bay Area', bbox: BAY_AREA_BBOX },
      recording: {
        startedAt: new Date(result.startedAtMs).toISOString(),
        endedAt: new Date(result.endedAtMs).toISOString(),
        polls: result.polls,
        okPolls: result.okPolls,
        errors: result.errors,
        skippedAircraft: result.skipped,
      },
      precision: FLIGHT_PRECISION,
      parquet: FLIGHT_PARQUET_OPTIONS,
      file: fileName,
      rows: written.rows,
      bytes: written.bytes,
      sha256: written.sha256,
      distinctAircraft: written.distinctAircraft,
      columns: written.columns,
      query: written.query,
      generatedAt: new Date().toISOString(),
    };
    await writeFile(path.join(outDir, fileName.replace(/\.parquet$/, '.manifest.json')), `${JSON.stringify(manifest, null, 2)}\n`);
    log(`wrote ${path.relative(process.cwd(), written.file)}: ${written.rows.toLocaleString('en-US')} rows, ${written.distinctAircraft} aircraft, ${formatBytes(written.bytes)} in ${seconds(t0)} s`);
  } finally {
    duck.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

runCli(main);

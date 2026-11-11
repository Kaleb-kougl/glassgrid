/**
 * One day of Bay Area air traffic from adsb.lol's whole-sky archive, as the
 * pinned fixtures for the live-flights views.
 *
 *   pnpm --filter @glassgrid/datasets globe-history -- --date 2026-11-09
 *   pnpm --filter @glassgrid/datasets globe-history -- --date 2026-11-09 --release prod-0 --out DIR
 *   pnpm --filter @glassgrid/datasets globe-history -- --date 2026-11-09 --from-file part.aa --from-file part.ab
 *   pnpm --filter @glassgrid/datasets globe-history -- --date 2026-11-09 --reuse-cache   # re-export, no download
 *
 * Streams the release's tar parts (about 3.7 GB for a day, sequential HTTP
 * fetches read as one tar) through `lib/tar.ts`, gunzips each
 * `traces/<xx>/trace_full_<hex>.json`, keeps the fixes inside
 * `BAY_AREA_BBOX` and inside the UTC day, and never writes the tar to disk.
 * Then, with DuckDB:
 *
 * - `flights-bay-day.parquet`: every kept fix of the day;
 * - 10 s snapshots ("the latest fix per aircraft within the last 60 s" at
 *   each tick) to count aircraft in view, and the 30-minute window with
 *   the most distinct aircraft;
 * - `flights-bay-30min.parquet`: the fixes of that window, plus the 60 s
 *   before it so its first snapshot is complete;
 * - `flights.manifest.json`: rows, bytes, SHA-256, columns, the release tag,
 *   asset names, sizes and SHA-256, filters and the measurements;
 * - `LICENSE-ODbL.md`: the data's licence and attribution (ODbL 1.0,
 *   © adsb.lol contributors).
 *
 * The extracted fixes (full precision) are also kept in
 * `out/cache/flights/<tag>.points.parquet` (gitignored, about 22 MB), so
 * `--reuse-cache` can redo the outputs without streaming the release again.
 *
 * Determinism: the same release gives the same Parquet bytes (fixes are
 * de-duplicated on (hex, ts), rounded, totally ordered and written by one
 * thread; see lib/flights.ts). Needs network access to github.com and its
 * release-asset host; behind a proxy set NODE_USE_ENV_PROXY=1.
 */
import { createReadStream } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { BAY_AREA_BBOX } from '@glassgrid/core';
import { cliArgs, ensureDir, formatBytes, log, PACKAGE_ROOT, runCli, seconds, sqlString } from './lib/common.ts';
import { openDuck, type Duck } from './lib/duck.ts';
import {
  appendFlightPoints,
  busiestWindow,
  createFlightTable,
  createSnapshots,
  FLIGHT_PARQUET_OPTIONS,
  FLIGHT_PRECISION,
  inViewStats,
  sha256File,
  SNAPSHOT,
  writeFlightParquet,
  type WrittenParquet,
} from './lib/flights.ts';
import {
  extractFixes,
  releaseFor,
  releasePageUrl,
  resolveRelease,
  streamAssets,
  type ReleaseAsset,
  type ReleaseRef,
  type StreamedAsset,
} from './lib/globe-history.ts';
import { generatorInfo } from './lib/manifest.ts';

/** Bump when the files this recipe writes would change for the same release. */
const RECIPE = 'flights-globe-history/1';
const DEFAULT_OUT = path.resolve(PACKAGE_ROOT, '..', '..', 'apps', 'web', 'public', 'samples', 'flights');
const WINDOW_MS = 30 * 60_000;
const DAY_FILE = 'flights-bay-day.parquet';
const WINDOW_FILE = 'flights-bay-30min.parquet';
const AREA = { name: 'San Francisco Bay Area', bbox: BAY_AREA_BBOX };
/** Warn when a fixture outgrows what is reasonable to commit. */
const SIZE_BUDGET = 20_000_000;

const ODBL_URL = 'https://opendatacommons.org/licenses/odbl/1.0/';

function licenceNotice(tag: string, pageUrl: string, assets: readonly StreamedAsset[], date: string): string {
  const { south, north, west, east } = AREA.bbox;
  return `# Flight data licence: ODbL 1.0

The files in this folder (\`${DAY_FILE}\`, \`${WINDOW_FILE}\` and the
measurements in \`flights.manifest.json\`) are derived from the
[adsb.lol](https://adsb.lol) ADS-B archive.

**Data © adsb.lol contributors, licensed under the
[Open Database License (ODbL) 1.0](${ODBL_URL}).**
adsb.lol aggregates reports from volunteer receivers ("use it freely, just
keep it open"). The release's own \`README.txt\` says: "This database is
made available under the Open Database License" and "This is made possible
by the adsb.lol feeders" (who waive their rights to the data they feed under
CC0 1.0).

These derived databases are themselves made available under the ODbL 1.0:
you may use, share and adapt them, as long as you attribute adsb.lol
contributors, keep any adapted database open under the ODbL, and do not
add technical restrictions. The rest of Glassgrid (code, synthetic
samples) is MIT; that licence does not cover these files.

## Source

- Release: [\`${tag}\`](${pageUrl}) (readsb whole-sky history for the UTC day ${date}).
- Assets, concatenated into one tar and streamed (never stored):
${assets.map((a) => `  - \`${a.name}\`: ${a.bytes.toLocaleString('en-US')} bytes, SHA-256 \`${a.sha256}\``).join('\n')}

## What was done to it

Produced by \`tools/datasets/src/globe-history.ts\` (recipe \`${RECIPE}\`):

1. Read every \`traces/<xx>/trace_full_<hex>.json\` (readsb trace format);
   ignored the rest of the archive (\`heatmap/\`, \`acas/\`).
2. Kept only fixes with ${south} <= lat <= ${north} and ${west} <= lon <= ${east}
   (${AREA.name}) and a time inside ${date} 00:00–24:00 UTC.
3. Mapped each fix to Glassgrid's flight-point schema
   (\`packages/core/src/flights\`): callsign, squawk and category carried
   forward from the last detailed point of the same leg; geometric altitudes
   and rates moved out of the barometric fields; registration and type from
   the archive's aircraft database fields.
4. Dropped duplicate (hex, time) fixes; rounded positions to
   ${FLIGHT_PRECISION.latLonDecimals} decimals, speed and track to 0.1, altitudes and vertical
   rates to whole feet and feet per minute; sorted by aircraft, then time.
5. \`${WINDOW_FILE}\` is the 30-minute window with the most distinct aircraft
   in 10-second snapshots, plus the 60 seconds before it.

No other fields were added, and no data from other sources was mixed in.
`;
}

interface LocalAsset extends ReleaseAsset {
  localPath: string;
}

/** Local copies of the parts, read in the order given (for re-runs from a downloaded copy, and for tests). */
async function* streamLocal(assets: readonly LocalAsset[], done: StreamedAsset[], onProgress: (bytes: number) => void): AsyncGenerator<Uint8Array> {
  let total = 0;
  for (const asset of assets) {
    let bytes = 0;
    for await (const chunk of createReadStream(asset.localPath, { highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      total += chunk.length;
      onProgress(total);
      yield chunk;
    }
    done.push({ name: asset.name, url: asset.url, bytes, sha256: await sha256File(asset.localPath), resumes: 0 });
  }
}

function fileEntry(id: string, written: WrittenParquet, outDir: string) {
  return {
    id,
    file: path.relative(outDir, written.file),
    rows: written.rows,
    bytes: written.bytes,
    sha256: written.sha256,
    distinctAircraft: written.distinctAircraft,
    firstFix: written.firstFix,
    lastFix: written.lastFix,
    columns: written.columns,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: cliArgs(),
    options: {
      date: { type: 'string' },
      release: { type: 'string', default: 'prod-0' },
      out: { type: 'string', default: DEFAULT_OUT },
      'from-file': { type: 'string', multiple: true },
      'memory-limit': { type: 'string' },
      'reuse-cache': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || values.date === undefined) {
    process.stdout.write(
      'Usage: pnpm --filter @glassgrid/datasets globe-history -- --date YYYY-MM-DD [--release prod-0] [--out DIR] [--from-file PART ...] [--reuse-cache]\n',
    );
    if (values.date === undefined && !values.help) process.exitCode = 1;
    return;
  }
  const date = values.date;
  const ref = releaseFor(date, values.release);
  const startMs = Date.parse(`${date}T00:00:00Z`);
  const endMs = startMs + 86_400_000;
  const outDir = await ensureDir(path.resolve(values.out));
  const tmp = await ensureDir(path.join(PACKAGE_ROOT, 'out', 'cache', 'duckdb-tmp-flights'));
  const cacheDir = await ensureDir(path.join(PACKAGE_ROOT, 'out', 'cache', 'flights'));
  const stagingFile = path.join(cacheDir, `${ref.tag}.points.parquet`);
  const sidecarFile = path.join(cacheDir, `${ref.tag}.stream.json`);
  const t0 = performance.now();
  const duck = await openDuck({ tempDirectory: tmp, threads: 1, ...(values['memory-limit'] ? { memoryLimit: values['memory-limit'] } : {}) });
  try {
    await createFlightTable(duck.conn, 'points');
    let streamedRun: StreamRun | null = null;
    if (values['reuse-cache']) {
      try {
        streamedRun = JSON.parse(await readFile(sidecarFile, 'utf8')) as StreamRun;
        await duck.conn.run(`INSERT INTO points SELECT * FROM read_parquet(${sqlString(stagingFile)})`);
        log(`${ref.tag}: reusing the extracted fixes in ${path.relative(process.cwd(), stagingFile)} (streamed ${streamedRun.streamedAt})`);
      } catch (err) {
        throw new Error(`--reuse-cache: no usable cache for ${ref.tag} in ${cacheDir}`, { cause: err });
      }
    }
    const run = streamedRun ?? (await streamRelease(duck, ref, values['from-file'] ?? [], { startMs, endMs, t0 }));
    if (!streamedRun) {
      // Keep the raw extracted fixes so a re-export (new rounding, new window rule) needs no new download.
      await duck.conn.run(`COPY points TO ${sqlString(stagingFile)} (FORMAT parquet, COMPRESSION zstd)`);
      await writeFile(sidecarFile, `${JSON.stringify(run, null, 2)}\n`);
    }
    await writeOutputs(duck, ref, run, { date, startMs, endMs, outDir, t0 });
  } finally {
    duck.close();
    await rm(tmp, { recursive: true, force: true });
  }
}

interface StreamRun {
  discoveredBy: string;
  assets: ReleaseAsset[];
  streamed: StreamedAsset[];
  stats: Awaited<ReturnType<typeof extractFixes>>;
  streamedAt: string;
}

/** Streams the release (or local copies of its parts) into the `points` table. */
async function streamRelease(duck: Duck, ref: ReleaseRef, localFiles: readonly string[], opts: { startMs: number; endMs: number; t0: number }): Promise<StreamRun> {
  const { startMs, endMs, t0 } = opts;
  // 1. Find the parts.
  let assets: ReleaseAsset[];
  let discoveredBy: string;
  if (localFiles.length > 0) {
    assets = localFiles.map((file) => ({ name: path.basename(file), url: `file:${path.resolve(file)}`, bytes: null, githubDigest: null, localPath: path.resolve(file) }) satisfies LocalAsset);
    discoveredBy = 'local-files';
  } else {
    const resolved = await resolveRelease(ref);
    assets = resolved.assets;
    discoveredBy = resolved.discoveredBy;
  }
  const totalBytes = assets.every((a) => a.bytes !== null) ? assets.reduce((n, a) => n + (a.bytes ?? 0), 0) : null;
  log(`${ref.tag}: ${assets.map((a) => `${a.name}${a.bytes === null ? '' : ` (${formatBytes(a.bytes)})`}`).join(', ')} [${discoveredBy}]`);

  // 2. Stream, extract, append.
  const appender = await duck.conn.createAppender('points');
  const streamed: StreamedAsset[] = [];
  let lastLog = performance.now();
  let pointsSoFar = 0;
  const progress = (bytes: number) => {
    const now = performance.now();
    if (now - lastLog < 30_000) return;
    lastLog = now;
    const mbps = bytes / 1e6 / ((now - t0) / 1000);
    log(`  ${formatBytes(bytes)}${totalBytes ? ` / ${formatBytes(totalBytes)}` : ''} (${mbps.toFixed(1)} MB/s), ${pointsSoFar.toLocaleString('en-US')} fixes kept`);
  };
  const source =
    discoveredBy === 'local-files'
      ? streamLocal(assets as LocalAsset[], streamed, progress)
      : streamAssets(assets, streamed, {
          onProgress: progress,
          onRetry: (name, offset, error) => log(`  ${name}: retrying from byte ${offset} (${error instanceof Error ? error.message : String(error)})`),
        });
  const stats = await extractFixes(source, {
    bbox: AREA.bbox,
    startMs,
    endMs,
    onPoints: (points) => {
      pointsSoFar += appendFlightPoints(appender, points);
    },
  });
  appender.flushSync();
  appender.closeSync();
  if (streamed.length !== assets.length) throw new Error(`the tar ended after ${streamed.length} of ${assets.length} parts`);
  log(
    `streamed ${formatBytes(streamed.reduce((n, a) => n + a.bytes, 0))} in ${seconds(t0)} s: ${stats.traceFiles.toLocaleString('en-US')} trace files, ` +
      `${stats.aircraftInBox.toLocaleString('en-US')} aircraft and ${stats.fixesKept.toLocaleString('en-US')} fixes in the box`,
  );
  if (stats.otherPaths.length > 0) log(`  other tar entries: ${stats.otherPaths.join(', ')}`);
  if (stats.fixesKept === 0) throw new Error('no fixes in the box: wrong day, or the archive format changed');
  return { discoveredBy, assets: assets.map(({ name, url, bytes, githubDigest }) => ({ name, url, bytes, githubDigest })), streamed, stats, streamedAt: new Date().toISOString() };
}

/** Writes the two Parquet files, the manifest and the licence notice from the `points` table. */
async function writeOutputs(
  duck: Duck,
  ref: ReleaseRef,
  run: StreamRun,
  opts: { date: string; startMs: number; endMs: number; outDir: string; t0: number },
): Promise<void> {
  const { date, startMs, endMs, outDir, t0 } = opts;
  const { assets, discoveredBy, streamed, stats } = run;
  // 3. Files and measurements.
  const day = await writeFlightParquet(duck.conn, 'points', path.join(outDir, DAY_FILE));
  await createSnapshots(duck.conn, 'points', startMs, endMs);
  const dayInView = await inViewStats(duck.conn, startMs, endMs);
  const window = await busiestWindow(duck.conn, startMs, endMs, WINDOW_MS);
  const windowFile = await writeFlightParquet(
    duck.conn,
    'points',
    path.join(outDir, WINDOW_FILE),
    `ts >= ${window.startMs - SNAPSHOT.holdMs} AND ts < ${window.endMs}`,
  );
  const windowInView = await inViewStats(duck.conn, window.startMs, window.endMs);
  for (const w of [day, windowFile]) {
    log(`  ${path.basename(w.file)}: ${w.rows.toLocaleString('en-US')} rows, ${w.distinctAircraft.toLocaleString('en-US')} aircraft, ${formatBytes(w.bytes)}`);
    if (w.bytes > SIZE_BUDGET) log(`  warning: ${path.basename(w.file)} is over ${formatBytes(SIZE_BUDGET)}`);
  }

  const pageUrl = releasePageUrl(ref);
  const manifest = {
    manifestVersion: 1,
    dataset: 'flights-bay',
    recipe: RECIPE,
    generator: generatorInfo(RECIPE, duck.version),
    licence: {
      id: 'ODbL-1.0',
      url: ODBL_URL,
      attribution: 'Data © adsb.lol contributors, licensed under the Open Database License (ODbL) 1.0',
      notice: 'LICENSE-ODbL.md',
    },
    source: {
      provider: 'adsb.lol',
      page: 'https://adsb.lol',
      repo: `https://github.com/${ref.repo}`,
      release: ref.tag,
      releasePage: pageUrl,
      discoveredBy,
      assets: streamed.map((a) => ({
        name: a.name,
        bytes: a.bytes,
        sha256: a.sha256,
        githubDigest: assets.find((x) => x.name === a.name)?.githubDigest ?? null,
      })),
      format: 'readsb trace_full JSON (gzip) in a split tar; https://github.com/wiedehopf/readsb/blob/dev/README-json.md',
    },
    area: { name: AREA.name, bbox: AREA.bbox },
    day: { date, startUtc: new Date(startMs).toISOString(), endUtc: new Date(endMs).toISOString() },
    extraction: stats,
    precision: FLIGHT_PRECISION,
    parquet: FLIGHT_PARQUET_OPTIONS,
    snapshots: {
      tickSeconds: SNAPSHOT.tickMs / 1000,
      holdSeconds: SNAPSHOT.holdMs / 1000,
      rule: 'at each tick, every aircraft whose latest in-box fix is less than holdSeconds old',
    },
    measurements: {
      totalFixes: day.rows,
      /** Fixes that repeated an aircraft's timestamp (readsb logged two positions a few metres apart); one of each kept. */
      duplicateFixesDropped: stats.fixesKept - day.rows,
      distinctAircraft: day.distinctAircraft,
      dayInView,
      busiestWindow: {
        startUtc: new Date(window.startMs).toISOString(),
        endUtc: new Date(window.endMs).toISOString(),
        rule: 'the 30-minute window starting on a whole minute with the most distinct aircraft in its snapshots; ties: most aircraft-snapshots, then earliest',
        distinctAircraft: window.distinctAircraft,
        inView: windowInView,
      },
    },
    files: [fileEntry('day', day, outDir), { ...fileEntry('30min', windowFile, outDir), includesLeadInSeconds: SNAPSHOT.holdMs / 1000 }],
    query: { day: day.query, window: windowFile.query },
    generatedAt: new Date().toISOString(),
    elapsedSeconds: seconds(t0),
  };
  await writeFile(path.join(outDir, 'flights.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(outDir, 'LICENSE-ODbL.md'), licenceNotice(ref.tag, pageUrl, streamed, date));
  log(
    `done in ${seconds(t0)} s: in view per 10 s snapshot peak ${dayInView.peak} (${dayInView.peakAt ?? '-'}), median ${dayInView.median}; ` +
      `busiest 30 min ${manifest.measurements.busiestWindow.startUtc} (${window.distinctAircraft} aircraft)`,
  );
}

runCli(main);

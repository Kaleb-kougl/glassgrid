/**
 * Recomputes row count, size and SHA-256 of each dataset CSV and compares them
 * to its manifest, and to the reference hash in pins.json when there is one
 * for the same recipe and DuckDB version. Exits non-zero on any mismatch.
 *
 *   npm run verify                                   # every *.manifest.json in out/
 *   npm run verify -- out/nyc-taxi-yellow-10m.manifest.json
 *   npm run verify -- out/synthetic-1m-seed42.csv    # the manifest next to it
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_OUT_DIR, formatBytes, log, runCli, seconds } from './lib/common.ts';
import { manifestPathFor, verifyManifest } from './lib/manifest.ts';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { out: { type: 'string', default: DEFAULT_OUT_DIR } },
  });

  let targets = positionals.map((p) => path.resolve(p.endsWith('.csv') ? manifestPathFor(p) : p));
  if (targets.length === 0) {
    const dir = path.resolve(values.out);
    targets = (await readdir(dir)).filter((f) => f.endsWith('.manifest.json')).sort().map((f) => path.join(dir, f));
    if (targets.length === 0) throw new Error(`No *.manifest.json files in ${dir}`);
  }

  let failed = 0;
  for (const target of targets) {
    const t0 = performance.now();
    try {
      const r = await verifyManifest(target);
      const what = `${path.basename(r.csvPath)}: ${r.actual.rows.toLocaleString('en-US')} rows, ${formatBytes(r.actual.bytes)}, sha256 ${r.actual.sha256}`;
      const pin = r.pin === 'none' ? 'no pin' : `pin ${r.pin}`;
      if (r.ok) {
        log(`OK    ${what} (${pin}, ${seconds(t0)} s)`);
      } else {
        failed++;
        log(`FAIL  ${what} (${pin})`);
        for (const p of r.problems) log(`        ${p}`);
      }
      for (const n of r.notes) log(`        note: ${n}`);
    } catch (err) {
      failed++;
      log(`FAIL  ${path.basename(target)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed > 0) throw new Error(`${failed} of ${targets.length} dataset(s) failed verification`);
}

runCli(main);

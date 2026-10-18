import { medians, runWorkload, type WorkloadTimings } from '../../src/testing/m4-bench';
import { createWorkerEngine, type WorkerEngineInfo } from '../../src/web';

/*
 * The M4 browser bench: `runs` cold passes of the shared workload
 * (src/testing/m4-bench.ts), each in a new engine worker, over the synthetic
 * CSV as a picked `File` (fetched once into a Blob first, so the network is
 * not timed) and, when DuckDB-WASM can read Parquet, its Parquet copy as a
 * sample dataset URL.
 */

export interface BenchResult {
  info: WorkerEngineInfo;
  /** Worker start to DuckDB-WASM ready (fetch and compile of the WASM build included). */
  startMs: number[];
  csv: { runs: WorkloadTimings[]; median: WorkloadTimings; sizeBytes: number };
  parquet: { runs: WorkloadTimings[]; median: WorkloadTimings } | { skipped: string };
  userAgent: string;
  hardwareConcurrency: number;
  deviceMemoryGb: number | null;
}

export async function runBench(csvPath: string, parquetPath: string | null, runs: number): Promise<BenchResult> {
  const blob = await (await fetch(csvPath)).blob();
  const file = new File([blob], csvPath.split('/').pop() ?? 'bench.csv', { type: 'text/csv', lastModified: Date.UTC(2026, 9, 1) });
  const startMs: number[] = [];
  const csvRuns: WorkloadTimings[] = [];
  const parquetRuns: WorkloadTimings[] = [];
  let info: WorkerEngineInfo | null = null;
  let parquetSkipped: string | null = parquetPath === null ? 'no Parquet file given' : null;

  for (let run = 0; run < runs; run += 1) {
    const started = performance.now();
    const engine = createWorkerEngine({});
    try {
      info = await engine.ready;
      startMs.push(Math.round((performance.now() - started) * 10) / 10);
      const source = await engine.registerFile(file);
      csvRuns.push(await runWorkload(engine, source.handle));
      if (parquetPath !== null && info.capabilities.parquet) {
        const sample = await engine.registerUrl(parquetPath);
        parquetRuns.push(await runWorkload(engine, sample.handle));
      } else if (parquetPath !== null) {
        parquetSkipped = `DuckDB-WASM has no Parquet extension here (${info.extensionErrors.join('; ') || 'no extension repository configured'})`;
      }
    } finally {
      engine.terminate();
    }
  }
  if (!info) throw new Error('No runs');
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  return {
    info,
    startMs,
    csv: { runs: csvRuns, median: medians(csvRuns), sizeBytes: file.size },
    parquet: parquetSkipped === null && parquetRuns.length > 0 ? { runs: parquetRuns, median: medians(parquetRuns) } : { skipped: parquetSkipped ?? 'not run' },
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemoryGb: memory ?? null,
  };
}

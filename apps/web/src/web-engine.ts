import type { CommandRegistry, OpenCsvResult } from '@glassgrid/core';
import { createWorkerEngine, type WorkerEngine } from '@glassgrid/engine/web';
import { absoluteUrl } from './base';
import { openSampleWorkspace, SAMPLES, type SampleInfo } from './samples';
import type { WebEngine } from './web-platform';

/*
 * The web demo's engine: DuckDB-WASM in a Web Worker (createWorkerEngine,
 * packages/engine/src/web), with the signed Parquet extension served from
 * this origin (public/duckdb-extensions/). The worker script, DuckDB-WASM's
 * JS and its 34 MB of WebAssembly (7.7 MB gzip) are fetched by the worker,
 * and not part of the first-load budget (scripts/size.ts).
 *
 * The worker starts lazily: on the first sign that the person will open
 * data (`prepare()`: pointer or focus on an open button or a sample, a file
 * dragged over the page, the file picker opening), or on the first
 * registration or request. A visitor who only looks at the start screen
 * downloads no WebAssembly; a `?sample=` link starts it before the app
 * mounts (app-route.tsx).
 */

/** performance.mark names (the E2E timings read them): DuckDB-WASM started; a sample workspace loaded into the app. */
export const ENGINE_READY_MARK = 'glassgrid:engine-ready';
export const SAMPLE_LOADED_MARK = 'glassgrid:sample-loaded';

export interface WebEngineOptions {
  readonly registry: Pick<CommandRegistry, 'dispatch'>;
  /** Defaults to this origin's <base>duckdb-extensions (extensionRepository()). */
  readonly extensionRepository?: string;
  readonly samples?: readonly SampleInfo[];
  /** An engine to use (tests); default: a new worker engine that starts lazily. */
  readonly engine?: WorkerEngine;
  readonly onSampleOpened?: (sample: SampleInfo) => void;
}

export interface DuckdbWebEngine extends WebEngine {
  /** The worker client itself (`ready`, `registerUrl`, diagnostics). */
  readonly worker: WorkerEngine;
}

/** The signed Parquet extension's repository on this origin: `https://host/duckdb-extensions`, or under the base. */
export function extensionRepository(origin: string, base?: string): string {
  return absoluteUrl('duckdb-extensions', origin, base);
}

export function createDuckdbWebEngine(options: WebEngineOptions): DuckdbWebEngine {
  const worker = options.engine ?? createWorkerEngine({ start: 'lazy', extensionRepository: options.extensionRepository ?? extensionRepository(location.origin) });
  const samples = options.samples ?? SAMPLES;
  // Visible in the console (and to the E2E tests): what DuckDB-WASM runs as, and whether Parquet loaded.
  worker.ready.then(
    (info) => {
      performance.mark(ENGINE_READY_MARK);
      const { parquet, cache, crossOriginIsolated } = info.capabilities;
      console.info(`[glassgrid] DuckDB-WASM ${info.duckdbVersion} ready (parquet: ${parquet}, cache: ${cache}, cross-origin isolated: ${crossOriginIsolated})`);
      if (info.extensionErrors.length > 0) console.warn('[glassgrid] DuckDB-WASM extensions failed to load:', info.extensionErrors.join('; '));
    },
    (error: unknown) => console.error('[glassgrid] DuckDB-WASM did not start:', error),
  );
  return {
    worker,
    engine: worker,
    prepare: () => worker.start(),
    registerFile: async (file: File): Promise<OpenCsvResult> => {
      const source = await worker.registerFile(file);
      return { status: 'opened', file: { handle: source.handle, displayName: source.fileName, sizeBytes: source.sizeBytes } };
    },
    samples,
    openSample: async (id: string): Promise<OpenCsvResult> => {
      const sample = samples.find((candidate) => candidate.id === id);
      if (!sample) return { status: 'failed', message: `There is no sample called ${id}` };
      const result = await openSampleWorkspace(sample, {
        engine: worker,
        registerUrl: (url, registerOptions) => worker.registerUrl(url, registerOptions),
        registry: options.registry,
        onWarnings: (warned, warnings) => console.warn(`[glassgrid] The ${warned.label} sample opened with changes:`, warnings.map((w) => w.message).join('; ')),
      });
      if (result.status === 'cancelled') {
        performance.mark(SAMPLE_LOADED_MARK, { detail: { sample: sample.id } });
        options.onSampleOpened?.(sample);
      }
      return result;
    },
  };
}

import { FLIGHTS_SAMPLE_ARCHIVE } from '@glassgrid/app';
import { LIVE_FIXTURES, liveFlightsUrl, type CommandRegistry, type LiveFixtureId, type OpenCsvResult } from '@glassgrid/core';
import { createWorkerEngine, type WorkerEngine } from '@glassgrid/engine/web';
import { absoluteUrl } from './base';
import { FLIGHTS_SAMPLE, openFlightsWorkspace } from './flights';
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
  /** A sample workspace opened (`flights` is the live-flights replay, which has no SampleInfo of its own). */
  readonly onSampleOpened?: (sample: Pick<SampleInfo, 'id'>) => void;
  /**
   * The live-flights endpoint (docs/live-flights-l2.md). Default: the site's
   * `/api/flights` on this origin (`liveFlightsUrl`), not under the app's
   * base. Under `pnpm dev:web` Vite proxies it to the portfolio's dev server
   * (`GLASSGRID_FLIGHTS_PROXY`, default http://localhost:3000; dev-proxy.ts);
   * `vite preview` has no such route (the live source backs off on its 404s).
   */
  readonly liveFlightsUrl?: string;
}

export interface DuckdbWebEngine extends WebEngine {
  /** The worker client itself (`ready`, `registerUrl`, diagnostics). */
  readonly worker: WorkerEngine;
}

/** The replay fixtures' URLs: `<base>samples/flights/<file>` on this origin. */
export function liveFixtureUrls(origin: string, base?: string): Record<LiveFixtureId, string> {
  const url = (id: LiveFixtureId) => absoluteUrl(`samples/flights/${LIVE_FIXTURES[id].file}`, origin, base);
  return { 'flights-bay-30min': url('flights-bay-30min'), 'flights-bay-day': url('flights-bay-day') };
}

/** The signed Parquet extension's repository on this origin: `https://host/duckdb-extensions`, or under the base. */
export function extensionRepository(origin: string, base?: string): string {
  return absoluteUrl('duckdb-extensions', origin, base);
}

export function createDuckdbWebEngine(options: WebEngineOptions): DuckdbWebEngine {
  const worker =
    options.engine ??
    createWorkerEngine({
      start: 'lazy',
      extensionRepository: options.extensionRepository ?? extensionRepository(location.origin),
      live: { url: options.liveFlightsUrl ?? liveFlightsUrl(location.origin), fixtures: liveFixtureUrls(location.origin) },
    });
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
    samples: [...samples, FLIGHTS_SAMPLE],
    openSample: async (id: string): Promise<OpenCsvResult> => {
      if (id === FLIGHTS_SAMPLE.id) {
        // The flights workspace over the live table, the 30-minute fixture loaded whole for the time scrubber (flights.ts).
        const result = await openFlightsWorkspace(FLIGHTS_SAMPLE_ARCHIVE, { engine: worker, registry: options.registry });
        if (result.status === 'cancelled') {
          performance.mark(SAMPLE_LOADED_MARK, { detail: { sample: FLIGHTS_SAMPLE.id } });
          options.onSampleOpened?.(FLIGHTS_SAMPLE);
        }
        return result;
      }
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

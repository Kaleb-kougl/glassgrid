import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { nodeFiles } from '../native/files';
import type { WasmBindings } from './bindings';
import { WasmDriver, type WasmDriverOptions } from './driver';

/*
 * DuckDB-WASM in Node: the same WASM build and driver as the web demo, with
 * DuckDB-WASM's Node runtime (files read through node:fs) instead of the
 * browser's. Used to run the engine's suite and benches against WASM
 * without a browser (`GLASSGRID_ENGINE_DRIVER=wasm`).
 */

const require = createRequire(import.meta.url);

interface BlockingModule {
  createDuckDB(
    bundles: { mvp: { mainModule: string; mainWorker: string }; eh?: { mainModule: string; mainWorker: string } },
    logger: unknown,
    runtime: unknown,
  ): Promise<WasmBindings & { instantiate(): Promise<unknown> }>;
  VoidLogger: new () => unknown;
  NODE_RUNTIME: unknown;
}

export interface NodeWasmDriverOptions extends Omit<WasmDriverOptions, 'bindings' | 'files'> {
  /** Use the MVP build instead of the exception-handling (EH) one. */
  mvp?: boolean;
}

export async function createNodeWasmDriver(options: NodeWasmDriverOptions): Promise<WasmDriver> {
  const duckdb = require('@duckdb/duckdb-wasm/blocking') as BlockingModule;
  const dist = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-eh.wasm'));
  const mvp = { mainModule: join(dist, 'duckdb-mvp.wasm'), mainWorker: '' };
  const bindings = await duckdb.createDuckDB(
    options.mvp === true ? { mvp } : { mvp, eh: { mainModule: join(dist, 'duckdb-eh.wasm'), mainWorker: '' } },
    new duckdb.VoidLogger(),
    duckdb.NODE_RUNTIME,
  );
  await bindings.instantiate();
  return new WasmDriver({ ...options, bindings, files: nodeFiles });
}

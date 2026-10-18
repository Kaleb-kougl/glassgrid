/*
 * The part of DuckDB-WASM's synchronous bindings (`@duckdb/duckdb-wasm/blocking`,
 * class `DuckDBBindings`) the WASM driver uses, typed structurally so the
 * engine does not depend on the package's typings (they pull in Emscripten's).
 * Every call runs DuckDB on the calling thread: in the web demo that is the
 * engine's own Web Worker, in tests the Node main thread.
 */

/** `DuckDBDataProtocol` of `@duckdb/duckdb-wasm`. */
export const DataProtocol = {
  BUFFER: 0,
  NODE_FS: 1,
  BROWSER_FILEREADER: 2,
  BROWSER_FSACCESS: 3,
  HTTP: 4,
  S3: 5,
} as const;

export interface WasmBindings {
  open(config: Record<string, unknown>): void;
  getVersion(): string;
  connect(): { useUnsafe<R>(callback: (bindings: unknown, connection: number) => R): R };
  disconnect(connection: number): void;
  runQuery(connection: number, text: string): Uint8Array;
  startPendingQuery(connection: number, text: string, allowStreamResult: boolean): Uint8Array | null;
  pollPendingQuery(connection: number): Uint8Array | null;
  cancelPendingQuery(connection: number): boolean;
  fetchQueryResults(connection: number): Uint8Array | null;
  registerFileHandle(name: string, handle: unknown, protocol: number, directIO: boolean): void;
  registerFileURL(name: string, url: string, protocol: number, directIO: boolean): void;
  registerOPFSFileName(file: string): Promise<void>;
  dropFile(name: string): void;
  flushFiles(): void;
}

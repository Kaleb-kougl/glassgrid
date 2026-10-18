import type {
  DatabaseOptions,
  DriverCapabilities,
  DriverFiles,
  DriverParam,
  DriverResult,
  DuckConnection,
  DuckDatabase,
  DuckDriver,
} from '../driver';
import { EngineFailure, errorMessage } from '../errors';
import { quoteIdent, quoteLiteral } from '../sql-text';
import { concatIpc, ipcToRows, normalizeIpc } from './arrow';
import type { WasmBindings } from './bindings';
import { argumentLiteral, inlineArguments, isPreparable } from './params';

/*
 * The DuckDB-WASM driver. It runs DuckDB through the synchronous
 * ("blocking") bindings on the engine's own thread: the Web Worker that also
 * runs QueryService in the web demo, or Node in tests and benches.
 *
 * - One DuckDB-WASM instance per driver. Each table gets its own in-memory
 *   database inside it (`ATTACH ':memory:'`, and `USE` on every connection),
 *   so its views, sort indexes and cubes go away with `DETACH` when the
 *   table closes. A second WASM instance per table would cost about 0.8 s
 *   and 90 MB each (measured in Node).
 * - Sandbox (set once at start, then `lock_configuration`): extension
 *   autoload and autoinstall off, `enable_external_access = false`, and
 *   `allowed_directories` = the driver's roots (the browser's registered
 *   sources and OPFS cache, or the test temp folder). Unlike the native
 *   driver, tables share one allowlist: a crafted query of one table can read
 *   another table's file. There is no local file system in the browser, and
 *   every readable file was picked by the person in this tab.
 * - Statements run as pending queries polled from the event loop, so the
 *   worker stays responsive between DuckDB's scheduling steps and other
 *   connections' queries interleave. `interrupt()` cancels at the next step
 *   (cooperative: DuckDB-WASM has no thread to interrupt a running step;
 *   a step of a large sort can take a few hundred ms).
 * - No progress reporting (the bindings have no progress API) and no
 *   spilling (no temp folder): a query past the memory limit fails with
 *   `out_of_memory`.
 */

export interface WasmDriverOptions {
  /** DuckDB-WASM's synchronous bindings, instantiated but not yet opened. */
  bindings: WasmBindings;
  files: DriverFiles;
  /** Folder prefixes DuckDB may read and write (`allowed_directories`). Every table path must lie under one. */
  allowedRoots: readonly string[];
  /** DuckDB `memory_limit` for the whole instance. Default 1 GiB. */
  memoryLimitBytes?: number;
  /**
   * Extensions to load before the configuration is locked, from
   * `repository` (`custom_extension_repository`; the app's own origin in the
   * web demo). Parquet support (`parquet`) depends on it: DuckDB-WASM does
   * not link Parquet in. Missing or failing extensions only disable the
   * features that need them (see `capabilities.parquet`).
   */
  extensions?: { repository?: string; load: readonly string[] };
  /** Message for out-of-memory failures (the web demo points to the desktop app). */
  outOfMemoryMessage?: string;
  /** Runs before each statement, e.g. to register the OPFS files it names. */
  beforeStatement?: (sql: string) => Promise<void>;
  /** Runs after each statement (also after a failure), e.g. to release OPFS handles it opened. */
  afterStatement?: (sql: string) => Promise<void>;
  /** Lets the event loop run between pending-query steps. Default: setImmediate when present, else a MessageChannel. */
  yieldToEventLoop?: () => Promise<void>;
  /** Called once when DuckDB-WASM trapped (out of memory, abort); the instance is unusable afterwards. */
  onFatal?: (message: string) => void;
}

export const DEFAULT_WASM_MEMORY_LIMIT_BYTES = 1024 ** 3;
export const DEFAULT_OUT_OF_MEMORY_MESSAGE = 'The query ran out of memory';

const INTERRUPTED = 'INTERRUPT Error: Interrupted!';

function defaultYield(): () => Promise<void> {
  const scope = globalThis as { setImmediate?: (callback: () => void) => unknown };
  const immediate = scope.setImmediate;
  if (typeof immediate === 'function') return () => new Promise((resolve) => immediate(() => resolve()));
  const channel = new MessageChannel();
  const waiting: Array<() => void> = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  return () =>
    new Promise((resolve) => {
      waiting.push(resolve);
      channel.port2.postMessage(null);
    });
}

function isOutOfMemory(message: string): boolean {
  return /Out of Memory Error|could not allocate|Maximum memory size exceeded|Out of memory|Cannot enlarge memory|bad_alloc/i.test(message);
}

/** A WebAssembly trap or Emscripten abort: the module's state is undefined afterwards. */
function isTrap(error: unknown): boolean {
  if (typeof WebAssembly !== 'undefined' && error instanceof WebAssembly.RuntimeError) return true;
  const message = errorMessage(error);
  return /^Aborted\(|RuntimeError|memory access out of bounds|unreachable/.test(message);
}

let nextDatabase = 0;

export class WasmDriver implements DuckDriver {
  readonly name = 'wasm';
  readonly files: DriverFiles;
  private readonly bindings: WasmBindings;
  private readonly roots: string[];
  private readonly memoryLimitBytes: number;
  private readonly yieldNow: () => Promise<void>;
  private started: Promise<string> | null = null;
  private parquet = false;
  /** Why an extension could not be loaded, for diagnostics. */
  extensionErrors: string[] = [];
  /** Set once DuckDB-WASM trapped; every call fails afterwards. */
  private fatal: string | null = null;

  constructor(private readonly options: WasmDriverOptions) {
    this.bindings = options.bindings;
    this.files = options.files;
    this.roots = options.allowedRoots.map((root) => (root.endsWith('/') ? root : `${root}/`));
    this.memoryLimitBytes = options.memoryLimitBytes ?? DEFAULT_WASM_MEMORY_LIMIT_BYTES;
    this.yieldNow = options.yieldToEventLoop ?? defaultYield();
  }

  get capabilities(): DriverCapabilities {
    return { interrupt: 'cooperative', progress: false, parquet: this.parquet, isolatedInstances: false, spill: false };
  }

  /** Open DuckDB, load extensions and lock the configuration. Idempotent. */
  start(): Promise<string> {
    this.started ??= Promise.resolve().then(() => this.open());
    return this.started;
  }

  private open(): string {
    const bindings = this.bindings;
    bindings.open({
      path: ':memory:',
      // Keep DuckDB's own Arrow types (the engine's mapping), not JS-friendly casts.
      query: { castBigIntToDouble: false, castDecimalToDouble: false, castTimestampToDate: false, castDurationToTime64: false },
      allowUnsignedExtensions: false,
      arrowLosslessConversion: false,
    });
    const connection = bindings.connect().useUnsafe((_, id) => id);
    const run = (sql: string) => bindings.runQuery(connection, sql);
    try {
      run('SET autoinstall_known_extensions = false');
      run('SET autoload_known_extensions = false');
      run('SET preserve_insertion_order = true');
      run(`SET memory_limit = '${Math.floor(this.memoryLimitBytes / (1024 * 1024))}MB'`);
      const extensions = this.options.extensions;
      if (extensions) {
        if (extensions.repository !== undefined) run(`SET custom_extension_repository = ${quoteLiteral(extensions.repository)}`);
        for (const name of extensions.load) {
          try {
            run(`LOAD ${quoteIdent(name)}`);
          } catch (error) {
            this.extensionErrors.push(`${name}: ${errorMessage(error)}`);
          }
        }
      }
      this.parquet = this.hasFunction(connection, 'read_parquet');
      run(`SET allowed_directories = [${this.roots.map(quoteLiteral).join(', ')}]`);
      run('SET enable_external_access = false');
      run('SET lock_configuration = true');
      return bindings.getVersion();
    } finally {
      bindings.disconnect(connection);
    }
  }

  private hasFunction(connection: number, name: string): boolean {
    const result = ipcToRows(
      this.bindings.runQuery(connection, `SELECT count(*) AS n FROM duckdb_functions() WHERE function_name = ${quoteLiteral(name)}`),
    );
    const count = result.rows[0]?.[0];
    return count !== undefined && count !== null && Number(count) > 0;
  }

  async createDatabase(options: DatabaseOptions): Promise<DuckDatabase> {
    await this.start();
    for (const path of [...options.allowedPaths, ...options.allowedDirectories]) {
      const normalized = path.endsWith('/') ? path : `${path}/`;
      if (!this.roots.some((root) => normalized.startsWith(root) || path.startsWith(root))) {
        throw new EngineFailure('io_failed', `"${path}" is outside the folders this engine may read`);
      }
    }
    nextDatabase += 1;
    const name = quoteIdent(`gg_db_${nextDatabase}`);
    await this.withSetupConnection((connection) => connection.run(`ATTACH ':memory:' AS ${name}`));
    return new WasmDatabase(this, name);
  }

  defaultMemoryLimitBytes(): number {
    return this.memoryLimitBytes;
  }

  removeTempDirectory(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    // The instance lives as long as its worker (or test process).
  }

  /** A raw connection, for the database and setup statements. */
  connectRaw(database: string | null): WasmConnection {
    this.assertUsable();
    const id = this.bindings.connect().useUnsafe((_, connection) => connection);
    const connection = new WasmConnection(this, id);
    if (database !== null) {
      try {
        this.bindings.runQuery(id, `USE ${database}`);
      } catch (error) {
        this.bindings.disconnect(id);
        throw this.failure(error, false);
      }
    }
    return connection;
  }

  async withSetupConnection<T>(fn: (connection: WasmConnection) => Promise<T>): Promise<T> {
    const connection = this.connectRaw(null);
    try {
      return await fn(connection);
    } finally {
      connection.close();
    }
  }

  // --- used by WasmConnection -------------------------------------------------

  get raw(): WasmBindings {
    return this.bindings;
  }

  assertUsable(): void {
    if (this.fatal !== null) throw new EngineFailure('engine_unavailable', this.fatal);
  }

  yieldToEventLoop(): Promise<void> {
    return this.yieldNow();
  }

  async beforeStatement(sql: string): Promise<void> {
    await this.options.beforeStatement?.(sql);
  }

  async afterStatement(sql: string): Promise<void> {
    await this.options.afterStatement?.(sql);
  }

  /** Map a bindings error to the engine's failures (interrupts keep DuckDB's native wording). */
  failure(error: unknown, interrupted: boolean): Error {
    if (interrupted) return new Error(INTERRUPTED);
    const message = errorMessage(error);
    if (isTrap(error)) {
      if (this.fatal === null) {
        this.fatal = `DuckDB-WASM stopped (${message}); reload the page`;
        this.options.onFatal?.(this.fatal);
      }
      return new EngineFailure(isOutOfMemory(message) ? 'out_of_memory' : 'engine_unavailable', this.outOfMemoryText(message), { cause: error });
    }
    if (isOutOfMemory(message)) return new EngineFailure('out_of_memory', this.outOfMemoryText(message), { cause: error });
    if (/query was cancell?ed|Interrupted/i.test(message)) return new Error(INTERRUPTED);
    return error instanceof Error ? error : new Error(message);
  }

  private outOfMemoryText(detail: string): string {
    return `${this.options.outOfMemoryMessage ?? DEFAULT_OUT_OF_MEMORY_MESSAGE} (${detail.split('\n')[0] ?? detail})`;
  }
}

class WasmDatabase implements DuckDatabase {
  private closed = false;

  constructor(
    private readonly driver: WasmDriver,
    private readonly name: string,
  ) {}

  connect(): Promise<DuckConnection> {
    if (this.closed) return Promise.reject(new Error('Connection Error: the database is closed'));
    return Promise.resolve(this.driver.connectRaw(this.name));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.driver.withSetupConnection((connection) => connection.run(`DETACH DATABASE IF EXISTS ${this.name}`)).catch(() => undefined);
  }
}

let nextStatement = 0;

export class WasmConnection implements DuckConnection {
  private closed = false;
  /** An interrupt arrived during the current call. */
  private interrupted = false;
  /** A pending query is in flight (between start and its last poll). */
  private pending = false;

  constructor(
    private readonly driver: WasmDriver,
    private readonly id: number,
  ) {}

  async run(sql: string, params?: readonly DriverParam[]): Promise<void> {
    await this.statement(sql, params);
  }

  async query(sql: string, params?: readonly DriverParam[]): Promise<DriverResult> {
    return ipcToRows(await this.statement(sql, params));
  }

  async arrow(sql: string, params?: readonly DriverParam[]): Promise<Uint8Array> {
    return normalizeIpc(await this.statement(sql, params));
  }

  interrupt(): void {
    this.interrupted = true;
    if (this.pending) this.driver.raw.cancelPendingQuery(this.id);
  }

  enableProgress(): Promise<void> {
    return Promise.resolve();
  }

  progress(): number | null {
    return null;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) this.driver.raw.cancelPendingQuery(this.id);
    try {
      this.driver.raw.disconnect(this.id);
    } catch {
      // A trapped instance cannot disconnect; nothing else to release.
    }
  }

  /** Run one statement (with arguments through PREPARE/EXECUTE) and return its Arrow stream. */
  private async statement(sql: string, params: readonly DriverParam[] | undefined): Promise<Uint8Array> {
    this.interrupted = false;
    this.driver.assertUsable();
    if (this.closed) throw new Error('Connection Error: the connection is closed');
    await this.driver.beforeStatement(sql);
    try {
      if (!params || params.length === 0) return await this.execute(sql);
      if (!isPreparable(sql)) return await this.execute(inlineArguments(sql, params));
      nextStatement += 1;
      const name = quoteIdent(`gg_stmt_${nextStatement}`);
      await this.execute(`PREPARE ${name} AS ${sql}`);
      try {
        return await this.execute(`EXECUTE ${name}(${params.map(argumentLiteral).join(', ')})`);
      } finally {
        await this.execute(`DEALLOCATE ${name}`).catch(() => undefined);
      }
    } finally {
      await this.driver.afterStatement(sql).catch(() => undefined);
    }
  }

  /** An interrupt or close arrived (read through a method: it changes while `execute` awaits). */
  private stopRequested(): boolean {
    return this.interrupted || this.closed;
  }

  /** Start a pending query and poll it to completion, yielding to the event loop between steps. */
  private async execute(text: string): Promise<Uint8Array> {
    const bindings = this.driver.raw;
    if (this.interrupted) throw this.driver.failure(null, true);
    let header: Uint8Array | null;
    try {
      this.pending = true;
      header = bindings.startPendingQuery(this.id, text, false);
      while (header === null) {
        await this.driver.yieldToEventLoop();
        if (this.stopRequested()) {
          bindings.cancelPendingQuery(this.id);
          throw this.driver.failure(null, true);
        }
        header = bindings.pollPendingQuery(this.id);
      }
      this.pending = false;
      const chunks = [header.slice()];
      for (;;) {
        const chunk = bindings.fetchQueryResults(this.id);
        if (chunk === null || chunk.byteLength === 0) break;
        chunks.push(chunk.slice());
      }
      return concatIpc(chunks);
    } catch (error) {
      if (error instanceof EngineFailure) throw error;
      throw this.driver.failure(error, this.interrupted);
    } finally {
      this.pending = false;
    }
  }
}

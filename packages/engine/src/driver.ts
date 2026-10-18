/*
 * The seam between the engine core (QueryService, sessions, caches, cubes,
 * sort indexes) and a DuckDB binding. The core only talks to these
 * interfaces, so the same code runs on
 *
 * - the native binding (`@duckdb/node-api`) in Electron's utility process
 *   (`@glassgrid/engine/native`), and
 * - DuckDB-WASM in a Web Worker (`@glassgrid/engine/wasm`), or in Node
 *   for tests (`@glassgrid/engine/wasm/node`).
 *
 * See docs/m4-engine-portability.md for the contract and the documented
 * differences between the two.
 */

/**
 * A value read from a result through `DuckConnection.query`. Drivers map
 * DuckDB values to plain JS:
 *
 * - BOOLEAN to boolean; TINYINT..INTEGER, FLOAT, DOUBLE to number;
 *   BIGINT, UBIGINT and HUGEINT to bigint; DECIMAL(p, s>0) to its nearest
 *   number; VARCHAR to string;
 * - LIST to an array and STRUCT to a plain object of the same mapping;
 * - everything else (dates, timestamps, intervals, ...) to text. The native
 *   driver uses DuckDB's own rendering; the WASM driver formats them in
 *   ISO-like text. Engine code that needs exact text casts to VARCHAR in SQL.
 */
export type DriverValue = null | boolean | number | bigint | string | readonly DriverValue[] | { readonly [key: string]: DriverValue };

/** A fully read result: column names and row-major values. */
export interface DriverResult {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly DriverValue[])[];
}

/** A bound value. Numbers bind as DOUBLE, bigints as BIGINT (HUGEINT beyond), strings as VARCHAR. */
export type DriverParam = string | number | boolean | bigint | null;

/**
 * One connection to a table's database. Every engine request runs on its own
 * connection, so `interrupt()` stops exactly that request.
 */
export interface DuckConnection {
  /** Run a statement and discard its result. */
  run(sql: string, params?: readonly DriverParam[]): Promise<void>;
  /** Run a query and read its values (small results only: counts, profiles, DESCRIBE). */
  query(sql: string, params?: readonly DriverParam[]): Promise<DriverResult>;
  /**
   * Run a query and return its result as an Arrow IPC stream in the engine's
   * type mapping (docs/m2-engine-notes.md, "Arrow types"): DECIMAL as
   * Decimal128, TIME as Time64, INTERVAL as Interval(MONTH_DAY_NANO),
   * DATE/TIMESTAMP as DateDay/Timestamp, and types Arrow JS cannot show
   * (HUGEINT, UUID, BLOB, nested, ...) as Utf8 text.
   */
  arrow(sql: string, params?: readonly DriverParam[]): Promise<Uint8Array>;
  /**
   * Stop the statement running on this connection, if any. The statement
   * rejects with an error whose message starts with `INTERRUPT Error`
   * (see `isInterruptError`). An interrupt with nothing running is a no-op.
   */
  interrupt(): void;
  /**
   * Turn on progress tracking for this connection (used by the Parquet
   * conversion). Drivers without progress reporting make this a no-op and
   * `progress()` then stays null.
   */
  enableProgress(): Promise<void>;
  /** Progress of the running statement in percent (0..100), or null when unknown. */
  progress(): number | null;
  close(): void;
}

/** What a table's database may touch, fixed when it is created (see sandbox notes in the driver). */
export interface DatabaseOptions {
  /** Exact files the database may read (the table's source). */
  allowedPaths: readonly string[];
  /** Folders whose contents it may read and write (the Parquet cache). */
  allowedDirectories: readonly string[];
  /** Private spill folder (native); drivers without spilling ignore it. */
  tempDirectory: string;
  /** Memory limit in bytes. Drivers that share one budget across tables may ignore it. */
  memoryLimitBytes: number;
}

/** One table's isolated database. */
export interface DuckDatabase {
  connect(): Promise<DuckConnection>;
  /** Close the database (and remove its spill folder). Tables and views in it are gone afterwards. */
  close(): Promise<void>;
}

export interface FileInfo {
  sizeBytes: number;
  /** Last modification time in ms since the epoch (truncated to an integer). */
  mtimeMs: number;
  isFile: boolean;
}

/**
 * File operations the engine needs, on the driver's file system: the
 * user's files (native paths, or registered browser files and URLs) and the
 * Parquet cache folder (a native folder, or OPFS). Paths are opaque strings
 * built with `join`; DuckDB reads the same strings.
 */
export interface DriverFiles {
  join(...parts: string[]): string;
  basename(path: string): string;
  dirname(path: string): string;
  stat(path: string): Promise<FileInfo>;
  /** Bytes [position, position + length) of a file, shorter at the end of the file. */
  readRange(path: string, position: number, length: number): Promise<Uint8Array>;
  mkdir(path: string): Promise<void>;
  /** Names (not paths) of the entries of a folder; empty when it does not exist. */
  readdir(path: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  /** Remove a file or folder (recursively); missing is fine. */
  remove(path: string): Promise<void>;
  /** Mark a file as recently used (LRU recency). May be a no-op where mtimes cannot be set. */
  touch(path: string): Promise<void>;
  /** SHA-256 over the concatenated chunks, as lowercase hex. */
  sha256(chunks: readonly Uint8Array[]): Promise<string>;
}

export interface DriverCapabilities {
  /**
   * `immediate`: `interrupt()` stops a statement within milliseconds (native).
   * `cooperative`: the statement stops at its next scheduling point, after
   * up to a few hundred ms of work (DuckDB-WASM's pending queries).
   */
  interrupt: 'immediate' | 'cooperative';
  /** `progress()` reports percentages. */
  progress: boolean;
  /** Parquet can be read and written (COPY TO parquet, read_parquet). */
  parquet: boolean;
  /** Each table gets its own instance with its own allowlist and memory limit. */
  isolatedInstances: boolean;
  /** Operators can spill to disk past the memory limit. */
  spill: boolean;
}

export interface DuckDriver {
  /** `native` or `wasm`, for diagnostics and tests. */
  readonly name: string;
  readonly capabilities: DriverCapabilities;
  readonly files: DriverFiles;
  /** Start DuckDB once, so a broken binding fails fast. Resolves with DuckDB's version string. */
  start(): Promise<string>;
  /** Create a table's database: locked down to `options` (see the driver for how strictly). */
  createDatabase(options: DatabaseOptions): Promise<DuckDatabase>;
  /** Default memory limit per table when the engine is not told one. */
  defaultMemoryLimitBytes(): number;
  /** Remove a spill folder left by a crashed run. */
  removeTempDirectory(path: string): Promise<void>;
  /** Release everything (instances, workers). */
  close(): void;
}

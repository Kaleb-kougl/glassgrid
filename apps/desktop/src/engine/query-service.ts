import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  DuckDBInstance,
  DuckDBListValue,
  DuckDBStructValue,
  type DuckDBConnection,
  type DuckDBValue,
} from '@duckdb/node-api';
import {
  tableIdForFile,
  type CacheScope,
  type ColumnInfo,
  type ColumnType,
  type ColumnTypeOverride,
  type ColumnTypeResult,
  type EngineEvent,
  type FileHandle,
  type Fingerprint,
  type ParquetCacheStats,
  type ParquetMode,
  type ResultCacheStats,
  type RowsQuery,
  type SortKey,
  type TableColumnProfile,
  type TableHandle,
  type TableId,
} from '@glassgrid/core';
import { tableFromIPC, tableToIPC, type Table } from 'apache-arrow';
import { readerToArrowIPC } from './arrow';
import { Coalescer } from './coalesce';
import { overrideDuckdbType, simpleColumnType, toCount, toScalar } from './column-types';
import {
  EngineFailure,
  errorMessage,
  isInterruptError,
  raceAbort,
  throwIfAborted,
  toEngineFailure,
} from './errors';
import { fingerprintFile } from './fingerprint';
import { DEFAULT_PARQUET_CACHE_BYTES, ParquetCache, type CacheEntry } from './parquet-cache';
import { DEFAULT_RESULT_CACHE_BYTES, ResultCache } from './result-cache';
import { createSandboxedInstance, defaultMemoryLimitBytes, removeTempDirectory } from './sandbox';
import { DEFAULT_MAX_SORT_INDEXES, SortIndexes, type BuildSpec } from './sort-indexes';
import { fragmentKey, intLiteral, quoteIdent, quoteLiteral, type SqlFragment, type SqlParam } from './sql-text';

export const DEFAULT_AUTO_CONVERT_MIN_BYTES = 200 * 1024 * 1024;
/**
 * Unsorted pages starting this deep into a CSV are served from the Parquet
 * copy (converting first if needed): an OFFSET that deep parses most of the
 * file anyway, and the copy makes every later page cheap.
 */
export const DEEP_PAGE_ROWS = 100_000;
/**
 * Sorted or filtered pages that end within this many rows are served by a
 * top-K query while the view's row-number index builds in the background.
 * DuckDB plans `ORDER BY ... LIMIT n` as a heap top-N only up to n = 5,000
 * when it cannot estimate the input size (CSV scans); beyond that it sorts
 * everything, which costs about as much as building the index.
 */
export const TOP_K_MAX_ROWS = 5_000;
const PROGRESS_INTERVAL_MS = 250;
/** Spill folders of instances that crashed are removed after this long. */
const STALE_TEMP_DIR_MS = 60 * 60 * 1000;

/** Hidden columns the engine adds; user columns with these names are not supported. */
const ORD = '__gg_ord';
const RN = '__gg_rn';

/** How sorted/filtered pages are served (`auto` in production; tests force one path). */
export type PagingStrategy = 'auto' | 'topK' | 'index';

export interface QueryServiceOptions {
  /** Parquet cache folder (main passes `<userData>/cache/parquet`). */
  cacheDir: string;
  parquetCacheMaxBytes?: number;
  autoConvertMinBytes?: number;
  resultCacheMaxBytes?: number;
  /** Root of the DuckDB spill folders (one per table); defaults to `<cacheDir>/../duckdb-tmp`. */
  tempDir?: string;
  maxSortIndexes?: number;
  /** DuckDB memory limit per open table (each has its own instance). Default: half of RAM. */
  memoryLimitBytes?: number;
  pagingStrategy?: PagingStrategy;
  /** Rows served by the top-K block while an index builds (default TOP_K_MAX_ROWS; tests lower it). */
  topKRows?: number;
}

/** Per-request context: cancellation and the view the request belongs to. */
export interface RequestContext {
  signal?: AbortSignal;
  viewId?: string;
}

export interface RowsOptions extends RowsQuery {
  /** Filter compiled by the spec compiler; bound values only. */
  where?: SqlFragment;
}

export interface Cached<T> {
  value: T;
  cached: boolean;
}

export interface TableProfile {
  rowCount: number;
  columns: TableColumnProfile[];
}

export interface ParquetCacheOutcome {
  table: TableHandle;
  alreadyCached: boolean;
  sizeBytes: number;
}

export interface ColumnTypesOutcome {
  table: TableHandle;
  columns: ColumnTypeResult[];
}

type Source = { kind: 'csv' } | { kind: 'parquet'; path: string; key: string };

type ColumnStats = Pick<TableColumnProfile, 'nullFraction' | 'distinctCount' | 'min' | 'max'>;

/**
 * '' before any type change, else a digest of the overrides and the type-change count, so a version
 * never repeats once the types changed (see TableState.version).
 */
function overridesVersion(state: Pick<TableState, 'overrides' | 'typeGeneration'>): string {
  const entries = [...state.overrides.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0 && state.typeGeneration === 0) return '';
  return createHash('sha256').update(JSON.stringify([entries, state.typeGeneration])).digest('hex').slice(0, 16);
}

interface TableState {
  id: TableId;
  file: FileHandle;
  csvPath: string;
  /** This table's own DuckDB instance, locked down to `csvPath` and the cache folder. */
  db: DuckDBInstance;
  tempDir: string;
  /**
   * `read_csv(...)` with the dialect and column types sniffed once at open
   * (null until first needed). Spelling the options out means later queries
   * bind without re-sniffing the file, which otherwise costs 30-60 ms each.
   */
  csvReader: string | null;
  fingerprint: Fingerprint;
  source: Source;
  parquetMode: ParquetMode;
  /** Columns as the source types them. */
  inferred: ColumnInfo[];
  /** Overrides that differ from the inferred type: column -> logical type. */
  overrides: Map<string, ColumnType>;
  /** Columns with overrides applied (what queries, the compiler and the profile see). */
  columns: ColumnInfo[];
  /**
   * '' before any type change, else a digest of the overrides and `typeGeneration`; part of every cache
   * key and index name. Never repeats after a change, so a query that raced a change (keyed by the old
   * version, run against the new views) is never served once the types change back.
   */
  version: string;
  /** Type changes applied so far. */
  typeGeneration: number;
  rowCount: number | undefined;
  /** Profile statistics per `name + DuckDB type`, so a type change rescans only that column. */
  stats: Map<string, ColumnStats>;
  /** Failed-cast counts per `name + DuckDB type`. */
  failedCasts: Map<string, number>;
  /** Serializes setColumnTypes calls. */
  typeChange: Promise<unknown>;
  /** Serializes view redefinitions (type changes, the switch to Parquet and back). */
  viewLock: Promise<unknown>;
  /** Connections running a query on `db` right now (shared with a reopened state over the same instance). */
  active: Set<DuckDBConnection>;
  /** Set by closeTable once the instance is closing; new queries on this state fail. */
  closed: boolean;
  /** Source columns, no casts. */
  rawView: string;
  /** The user's columns with overrides applied. */
  view: string;
  /** Same rows plus `__gg_ord`, the 0-based position in the file. */
  ordView: string;
}

type CachedValue =
  | { kind: 'ipc'; ipc: Uint8Array }
  | { kind: 'count'; rowCount: number }
  /** The first TOP_K_MAX_ROWS rows of a sorted/filtered view; `complete` when that is all of them. */
  | { kind: 'block'; table: Table; complete: boolean };

interface QueryServiceEvents {
  event: [EngineEvent];
}

interface ParquetJob {
  promise: Promise<{ entry: CacheEntry; alreadyCached: boolean }>;
}

/**
 * The engine's query layer: tables over CSV/Parquet files, profiles, grid
 * pages, counts, type overrides, the Parquet cache and the result cache. It
 * is plain Node (no Electron), so Vitest drives it against real DuckDB.
 *
 * Each open table has its own DuckDB instance whose external access is
 * locked to that file and the cache folder (see sandbox.ts). Every request
 * runs on its own connection, and `ctx.signal` maps to
 * `connection.interrupt()`, which DuckDB honours within milliseconds.
 * Identical in-flight requests share one query (see coalesce.ts).
 */
export class QueryService extends EventEmitter<QueryServiceEvents> {
  private readonly files = new Map<FileHandle, string>();
  private readonly tables = new Map<TableId, TableState>();
  private readonly opening = new Map<TableId, Promise<TableState>>();
  /** Renderer sessions using each table (see retainTable). */
  private readonly holders = new Map<TableId, Set<string>>();
  private readonly conversions = new Map<string, { interrupt: () => void }>();
  private readonly parquetJobs = new Map<string, ParquetJob>();
  private readonly results: ResultCache<CachedValue>;
  private readonly inflight = new Coalescer<CachedValue>();
  private readonly sortIndexes: SortIndexes;
  readonly parquetCache: ParquetCache;
  private readonly autoConvertMinBytes: number;
  private readonly tempRoot: string;
  private readonly memoryLimitBytes: number;
  private readonly pagingStrategy: PagingStrategy;
  private readonly topKRows: number;
  private closed = false;

  private constructor(options: QueryServiceOptions) {
    super();
    this.parquetCache = new ParquetCache(options.cacheDir, options.parquetCacheMaxBytes ?? DEFAULT_PARQUET_CACHE_BYTES);
    this.results = new ResultCache(options.resultCacheMaxBytes ?? DEFAULT_RESULT_CACHE_BYTES);
    this.sortIndexes = new SortIndexes(options.maxSortIndexes ?? DEFAULT_MAX_SORT_INDEXES);
    this.autoConvertMinBytes = options.autoConvertMinBytes ?? DEFAULT_AUTO_CONVERT_MIN_BYTES;
    this.tempRoot = options.tempDir ?? join(dirname(options.cacheDir), 'duckdb-tmp');
    this.memoryLimitBytes = options.memoryLimitBytes ?? defaultMemoryLimitBytes();
    this.pagingStrategy = options.pagingStrategy ?? 'auto';
    this.topKRows = options.topKRows ?? TOP_K_MAX_ROWS;
  }

  static async create(options: QueryServiceOptions): Promise<QueryService> {
    // Fail fast (and report engine_unavailable) if the native binding cannot start DuckDB.
    const probe = await DuckDBInstance.create(':memory:', { autoinstall_known_extensions: 'false' });
    probe.closeSync();
    const service = new QueryService(options);
    void service.removeStaleTempDirs();
    return service;
  }

  // -------------------------------------------------------------------------
  // Files and tables

  /**
   * Name of the view that exposes a table's columns (unquoted), with type
   * overrides applied. The chart compiler reads from it:
   * `compileChartQuery(quoteIdent(viewName), ...)`. Deterministic, so it is
   * valid as soon as the table is open.
   */
  static viewName(id: TableId): string {
    return `gg_${id}`;
  }

  /** Called by main (through the control channel) when the user picks a file. */
  registerFile(handle: FileHandle, path: string): void {
    this.files.set(handle, path);
  }

  unregisterFile(handle: FileHandle): void {
    this.files.delete(handle);
  }

  /**
   * Open a registered file as a table: a view over the CSV, or over the
   * cached Parquet copy when one matches the file's fingerprint. Idempotent;
   * reopening a file whose content changed rebuilds the views and drops its
   * cached results.
   */
  async open(file: FileHandle, options: { parquet?: ParquetMode } = {}, ctx: RequestContext = {}): Promise<TableHandle> {
    const csvPath = this.files.get(file);
    if (!csvPath) throw new EngineFailure('unknown_handle', 'This file is no longer open');
    const id = tableIdForFile(file);

    const state = await this.openTable(id, file, csvPath, ctx);
    const mode = options.parquet ?? 'auto';
    state.parquetMode = mode;
    if (
      state.source.kind === 'csv' &&
      (mode === 'always' || (mode === 'auto' && state.fingerprint.sizeBytes >= this.autoConvertMinBytes))
    ) {
      // Background conversion; progress and completion arrive as events.
      this.parquetJob(state).promise.catch(() => undefined);
    }
    return this.handleFor(state);
  }

  private openTable(id: TableId, file: FileHandle, csvPath: string, ctx: RequestContext): Promise<TableState> {
    const pending = this.opening.get(id);
    if (pending) return pending;
    const promise = this.doOpen(id, file, csvPath, ctx).finally(() => this.opening.delete(id));
    this.opening.set(id, promise);
    return promise;
  }

  private async doOpen(id: TableId, file: FileHandle, csvPath: string, ctx: RequestContext): Promise<TableState> {
    let fingerprint: Fingerprint;
    try {
      fingerprint = await fingerprintFile(csvPath);
    } catch (error) {
      throw new EngineFailure('io_failed', `Cannot read the file: ${errorMessage(error)}`, { cause: error });
    }

    const existing = this.tables.get(id);
    if (existing && existing.fingerprint.key === fingerprint.key) return existing;
    if (existing) {
      // The file changed on disk since it was opened.
      this.results.invalidateTable(id);
      await this.sortIndexes.drop(id);
    }

    let db = existing?.db;
    const tempDir = existing?.tempDir ?? join(this.tempRoot, id);
    if (!db) {
      await this.parquetCache.ready().catch(() => undefined);
      db = await createSandboxedInstance({
        allowedPaths: [csvPath],
        allowedDirectories: [this.parquetCache.dir],
        tempDirectory: tempDir,
        memoryLimitBytes: this.memoryLimitBytes,
      });
    }

    const cached = await this.parquetCache.lookup(fingerprint.key).catch(() => undefined);
    const source: Source = cached ? { kind: 'parquet', path: cached.path, key: cached.key } : { kind: 'csv' };
    const state: TableState = {
      id,
      file,
      csvPath,
      db,
      tempDir,
      csvReader: null,
      fingerprint,
      source,
      parquetMode: existing?.parquetMode ?? 'auto',
      inferred: [],
      overrides: new Map(),
      columns: [],
      version: '',
      typeGeneration: 0,
      rowCount: undefined,
      stats: new Map(),
      failedCasts: new Map(),
      typeChange: Promise.resolve(),
      viewLock: Promise.resolve(),
      active: existing?.active ?? new Set(),
      closed: false,
      rawView: quoteIdent(`gg_${id}_raw`),
      view: quoteIdent(QueryService.viewName(id)),
      ordView: quoteIdent(`gg_${id}_ord`),
    };

    try {
      await this.withConnection(state, ctx.signal, async (connection) => {
        await this.createRawView(connection, state);
        const described = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${state.rawView}`);
        state.inferred = described.getRowObjects().map((row) => {
          const name = String(row['column_name']);
          const duckdbType = String(row['column_type']);
          return { name, duckdbType, type: simpleColumnType(duckdbType) };
        });
        if (state.inferred.some((column) => column.name === ORD || column.name === RN)) {
          throw new EngineFailure('query_failed', `Columns named ${ORD} or ${RN} are reserved`);
        }
        // Overrides survive a content change for columns that still exist.
        for (const [column, type] of existing?.overrides ?? []) {
          const inferred = state.inferred.find((candidate) => candidate.name === column);
          if (inferred && inferred.type !== type) state.overrides.set(column, type);
        }
        this.applyOverrides(state);
        await this.createViews(connection, state);
        if (source.kind === 'parquet') {
          // Parquet row counts come from file metadata, so this is cheap.
          const counted = await connection.runAndReadAll(`SELECT count(*) FROM ${state.rawView}`);
          state.rowCount = toCount(counted.getRows()[0]?.[0] ?? null);
        }
      });
    } catch (error) {
      if (!existing) {
        db.closeSync();
        void removeTempDirectory(tempDir);
      }
      throw error;
    }

    this.tables.set(id, state);
    return state;
  }

  /** Recompute effective columns and (unless `keepVersion`) the version digest from `state.overrides`. */
  private applyOverrides(state: TableState, options: { keepVersion?: boolean } = {}): void {
    state.columns = state.inferred.map((column) => {
      const type = state.overrides.get(column.name);
      return type === undefined ? column : { name: column.name, type, duckdbType: overrideDuckdbType(type, column.duckdbType) };
    });
    if (options.keepVersion !== true) state.version = overridesVersion(state);
  }

  /** The SELECT list of `view`: every column, cast where overridden. */
  private castList(state: TableState): string {
    return state.columns
      .map((column, index) => {
        const name = quoteIdent(column.name);
        const inferred = state.inferred[index];
        return inferred && inferred.duckdbType !== column.duckdbType
          ? `TRY_CAST(${name} AS ${column.duckdbType}) AS ${name}`
          : name;
      })
      .join(', ');
  }

  private sourceRelation(connection: DuckDBConnection, state: TableState): Promise<string> | string {
    if (state.source.kind === 'parquet') {
      return `read_parquet(${quoteLiteral(state.source.path)}, file_row_number = true)`;
    }
    return this.csvReader(connection, state);
  }

  private async createRawView(connection: DuckDBConnection, state: TableState): Promise<void> {
    const source = await this.sourceRelation(connection, state);
    const select = state.source.kind === 'parquet' ? `* EXCLUDE (file_row_number)` : '*';
    await connection.run(`CREATE OR REPLACE VIEW ${state.rawView} AS SELECT ${select} FROM ${source}`);
  }

  private async createViews(connection: DuckDBConnection, state: TableState): Promise<void> {
    await this.createRawView(connection, state);
    const source = await this.sourceRelation(connection, state);
    const columns = this.castList(state);
    await connection.run(`CREATE OR REPLACE VIEW ${state.view} AS SELECT ${columns} FROM ${source}`);
    // On CSV, with preserve_insertion_order, an empty OVER () numbers rows in file order.
    const ord = state.source.kind === 'parquet' ? 'file_row_number' : '(row_number() OVER ()) - 1';
    await connection.run(`CREATE OR REPLACE VIEW ${state.ordView} AS SELECT ${ord} AS ${ORD}, ${columns} FROM ${source}`);
  }

  private async csvReader(connection: DuckDBConnection, state: TableState): Promise<string> {
    state.csvReader ??= await sniffCsvReader(connection, state.csvPath);
    return state.csvReader;
  }

  /** Find an open table, reopening it on demand after an engine restart. */
  private async table(id: TableId, ctx: RequestContext): Promise<TableState> {
    const state = this.tables.get(id);
    if (state) return state;
    const pending = this.opening.get(id);
    if (pending) return pending;
    const file = `fh_${id.slice('tb_'.length)}` as FileHandle;
    const csvPath = this.files.get(file);
    if (!csvPath) throw new EngineFailure('unknown_table', 'This table is not open');
    return this.openTable(id, file, csvPath, ctx);
  }

  /** A table's columns (name, effective logical type, DuckDB type), opening it on demand. */
  async columns(id: TableId, ctx: RequestContext = {}): Promise<ColumnInfo[]> {
    return (await this.table(id, ctx)).columns;
  }

  private handleFor(state: TableState): TableHandle {
    return {
      id: state.id,
      file: state.file,
      fileName: basename(state.csvPath),
      ...(state.rowCount === undefined ? {} : { rowCount: state.rowCount }),
      fingerprint: state.fingerprint,
      usingParquetCache: state.source.kind === 'parquet',
      columns: state.columns,
      ...(state.overrides.size === 0
        ? {}
        : { typeOverrides: [...state.overrides].map(([column, type]): ColumnTypeOverride => ({ column, type })) }),
    };
  }

  // -------------------------------------------------------------------------
  // Column type overrides

  /**
   * Replace the table's type overrides (the complete set). Counts the values
   * each override fails to convert and profiles the affected columns in one
   * scan, then redefines the views with TRY_CAST and drops the table's cached
   * results and sort indexes. Atomic: if the scan is cancelled or fails,
   * nothing changes.
   */
  async setColumnTypes(
    id: TableId,
    overrides: readonly ColumnTypeOverride[],
    ctx: RequestContext = {},
  ): Promise<ColumnTypesOutcome> {
    const state = await this.table(id, ctx);
    const run = state.typeChange.then(() => this.applyColumnTypes(state, overrides, ctx));
    state.typeChange = run.catch(() => undefined);
    return run;
  }

  private async applyColumnTypes(
    state: TableState,
    overrides: readonly ColumnTypeOverride[],
    ctx: RequestContext,
  ): Promise<ColumnTypesOutcome> {
    const next = new Map<string, ColumnType>();
    const requested = overrides.map((override) => {
      const inferred = state.inferred.find((column) => column.name === override.column);
      if (!inferred) throw new EngineFailure('unknown_column', `No column named "${override.column}"`);
      if (inferred.type !== override.type) next.set(override.column, override.type);
      return { inferred, type: override.type, duckdbType: overrideDuckdbType(override.type, inferred.duckdbType) };
    });

    // One scan over the raw columns: failed casts per override, stats for columns not profiled with their new type.
    const failedNeeded = requested.filter(
      (entry) => entry.duckdbType !== entry.inferred.duckdbType && !state.failedCasts.has(statKey(entry.inferred.name, entry.duckdbType)),
    );
    const statsNeeded = state.inferred
      .map((inferred) => {
        const type = next.get(inferred.name);
        return { inferred, duckdbType: type === undefined ? inferred.duckdbType : overrideDuckdbType(type, inferred.duckdbType) };
      })
      .filter((entry) => !state.stats.has(statKey(entry.inferred.name, entry.duckdbType)));

    if (failedNeeded.length > 0 || statsNeeded.length > 0) {
      await this.awaitConversion(state, ctx.signal);
      const cast = (entry: { inferred: ColumnInfo; duckdbType: string }) => {
        const name = quoteIdent(entry.inferred.name);
        return entry.duckdbType === entry.inferred.duckdbType ? name : `TRY_CAST(${name} AS ${entry.duckdbType})`;
      };
      const selects = ['count(*)'];
      for (const entry of failedNeeded) {
        selects.push(`count(*) FILTER (WHERE ${quoteIdent(entry.inferred.name)} IS NOT NULL AND ${cast(entry)} IS NULL)`);
      }
      for (const entry of statsNeeded) selects.push(...statSelects(cast(entry)));
      const row = await this.withConnection(state, ctx.signal, async (connection) => {
        const reader = await connection.runAndReadAll(`SELECT ${selects.join(', ')} FROM ${state.rawView}`);
        return reader.getRows()[0] ?? [];
      });
      const rowCount = toCount(row[0] ?? null);
      state.rowCount = rowCount;
      failedNeeded.forEach((entry, index) => {
        state.failedCasts.set(statKey(entry.inferred.name, entry.duckdbType), toCount(row[1 + index] ?? null));
      });
      const base = 1 + failedNeeded.length;
      statsNeeded.forEach((entry, index) => {
        state.stats.set(statKey(entry.inferred.name, entry.duckdbType), readStats(row, base + index * 4, rowCount));
      });
    }
    throwIfAborted(ctx.signal);

    const changed = !sameOverrides(state.overrides, next);
    if (changed) {
      const previous = state.overrides;
      state.overrides = next;
      state.typeGeneration += 1;
      // The version (part of every cache key) moves on only once the views read the new types: a query
      // keyed in between runs on either views and is cached under the old version, which never comes back.
      this.applyOverrides(state, { keepVersion: true });
      try {
        await this.withViewLock(state, () => this.withConnection(state, undefined, (connection) => this.createViews(connection, state)));
      } catch (error) {
        state.overrides = previous;
        this.applyOverrides(state, { keepVersion: true });
        throw error;
      }
      state.version = overridesVersion(state);
      this.results.invalidateTable(state.id);
      await this.sortIndexes.drop(state.id);
      this.emit('event', { type: 'tableUpdated', table: this.handleFor(state) });
    }

    return {
      table: this.handleFor(state),
      columns: requested.map(({ inferred, type, duckdbType }) => ({
        column: inferred.name,
        type,
        duckdbType,
        failedCasts: duckdbType === inferred.duckdbType ? 0 : (state.failedCasts.get(statKey(inferred.name, duckdbType)) ?? 0),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Queries

  /**
   * Per-column profile: non-null count, approximate distinct count
   * (HyperLogLog), min and max, in one aggregate scan. Cheaper than
   * SUMMARIZE (see docs/m1-engine-notes.md). Statistics are kept per column
   * and type, so after a type override only the affected columns are
   * scanned again.
   */
  async profile(id: TableId, ctx: RequestContext = {}): Promise<Cached<TableProfile>> {
    const state = await this.table(id, ctx);
    const assembled = assembleProfile(state);
    if (assembled) return { value: assembled, cached: true };

    // Statistics can be cleared (clearCache) while a scan runs; one retry covers that.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.scanProfile(state, ctx);
      const profile = assembleProfile(state);
      if (profile) return { value: profile, cached: false };
    }
    throw new EngineFailure('query_failed', 'The profile changed while it was computed; please retry');
  }

  private async scanProfile(state: TableState, ctx: RequestContext): Promise<void> {
    const key = this.key(state, ['profile']);
    await this.inflight.run(key, ctx.signal, async (signal) => {
      await this.awaitConversion(state, signal);
      const missing = state.columns.filter((column) => !state.stats.has(statKey(column.name, column.duckdbType)));
      const selects = ['count(*)'];
      for (const column of missing) selects.push(...statSelects(quoteIdent(column.name)));
      const row = await this.withConnection(state, signal, async (connection) => {
        const reader = await connection.runAndReadAll(`SELECT ${selects.join(', ')} FROM ${state.view}`);
        return reader.getRows()[0] ?? [];
      });
      const rowCount = toCount(row[0] ?? null);
      state.rowCount = rowCount;
      missing.forEach((column, index) => {
        state.stats.set(statKey(column.name, column.duckdbType), readStats(row, 1 + index * 4, rowCount));
      });
      return { kind: 'count', rowCount };
    });
  }

  /** Row count, optionally filtered by a compiled WHERE fragment. */
  async count(id: TableId, where?: SqlFragment, ctx: RequestContext = {}): Promise<Cached<number>> {
    const state = await this.table(id, ctx);
    const sql = `SELECT count(*) FROM ${state.view}${where ? ` WHERE (${where.sql})` : ''}`;
    const key = this.key(state, ['count', fragmentKey(where)]);
    const hit = this.results.get(key);
    if (hit?.kind === 'count') return { value: hit.rowCount, cached: true };

    const value = await this.inflight.run(key, ctx.signal, async (signal): Promise<CachedValue> => {
      // An unfiltered count parses little of each line, so it is cheaper than waiting for the
      // conversion; it is the row count the grid shows right after open.
      if (where) await this.awaitConversion(state, signal);
      const rowCount = await this.withConnection(state, signal, async (connection) => {
        const reader = await connection.runAndReadAll(sql, bind(where?.params));
        return toCount(reader.getRows()[0]?.[0] ?? null);
      });
      if (!where) state.rowCount = rowCount;
      const result: CachedValue = { kind: 'count', rowCount };
      this.results.set(key, result, 64);
      return result;
    });
    return { value: expectCount(value), cached: false };
  }

  /**
   * One grid page as Arrow IPC. Results are cached and coalesced by
   * (table, type overrides, offset, limit, sort, filter).
   *
   * - Unsorted and unfiltered: file order. On Parquet the page is a range
   *   predicate on `file_row_number` (row groups are skipped via
   *   statistics); on CSV it is LIMIT/OFFSET, which DuckDB returns in file
   *   order because insertion order is preserved. A CSV page deeper than
   *   DEEP_PAGE_ROWS waits for the Parquet copy (starting the conversion
   *   unless the table was opened with `parquet: 'never'`).
   * - Sorted and/or filtered: pages come from a row-number table
   *   materialized once per (table, overrides, sort, filter) and paged by
   *   `__gg_rn` range. Until it exists, pages ending within TOP_K_MAX_ROWS
   *   are answered by a top-K query and the table builds in the background.
   *   Both paths order by the sort keys and then by file position, so they
   *   return identical rows.
   */
  async rows(id: TableId, query: RowsOptions, ctx: RequestContext = {}): Promise<Cached<Uint8Array>> {
    const state = await this.table(id, ctx);
    const sort = query.sort ?? [];
    const orderBy = this.orderByClause(state, sort);
    const where = query.where;
    const indexed = sort.length > 0 || where !== undefined;
    const name = indexed ? sortIndexName(state, orderBy, where) : null;
    // The view now pages through this index (or none): builds it no longer needs stop.
    if (ctx.viewId !== undefined) this.sortIndexes.want(ctx.viewId, name);

    const key = this.key(state, ['rows', query.offset, query.limit, sort, fragmentKey(where)]);
    return this.cachedArrow(key, ctx, (signal) => {
      const inner = { ...ctx, signal };
      return name === null ? this.plainPage(state, query, inner) : this.indexedPage(state, query, orderBy, name, inner);
    });
  }

  private async plainPage(state: TableState, query: RowsOptions, ctx: RequestContext): Promise<Uint8Array> {
    if (state.source.kind === 'csv' && query.offset >= DEEP_PAGE_ROWS) await this.preferParquet(state, ctx.signal);
    const first = query.offset;
    const end = query.offset + query.limit;
    const sql =
      state.source.kind === 'parquet'
        ? `SELECT * EXCLUDE (${ORD}) FROM ${state.ordView} WHERE ${ORD} >= ${intLiteral(first)} AND ${ORD} < ${intLiteral(end)} ORDER BY ${ORD}`
        : `SELECT * FROM ${state.view} LIMIT ${intLiteral(query.limit)} OFFSET ${intLiteral(first)}`;
    return this.runArrow(state, sql, undefined, ctx.signal);
  }

  private async indexedPage(
    state: TableState,
    query: RowsOptions,
    orderBy: string,
    name: string,
    ctx: RequestContext,
  ): Promise<Uint8Array> {
    const where = query.where;
    const spec = this.indexSpec(state, name, orderBy, where);
    const end = query.offset + query.limit;
    const sorted = (query.sort ?? []).length > 0;
    const topK = (offset: number, limit: number) => {
      const filter = where ? ` WHERE (${where.sql})` : '';
      const limits = `LIMIT ${intLiteral(limit)} OFFSET ${intLiteral(offset)}`;
      // Unsorted + filtered: a streaming LIMIT keeps file order and stops early.
      return sorted
        ? `SELECT * EXCLUDE (${ORD}) FROM ${state.ordView}${filter} ORDER BY ${orderBy} ${limits}`
        : `SELECT * FROM ${state.view}${filter} ${limits}`;
    };

    if (this.pagingStrategy === 'topK') {
      if (sorted) await this.awaitConversion(state, ctx.signal);
      return this.runArrow(state, topK(query.offset, query.limit), where?.params, ctx.signal);
    }

    if (this.pagingStrategy === 'auto' && !this.sortIndexes.isReady(name)) {
      // The first TOP_K_MAX_ROWS rows come from one top-K query (a heap, one
      // scan); every page inside them is a slice of it. The index builds once
      // the block is served, so the two do not compete for cores.
      const blockKey = this.key(state, ['topK', orderBy, fragmentKey(where)]);
      const cachedBlock = this.results.get(blockKey);
      if (end <= this.topKRows || (cachedBlock?.kind === 'block' && cachedBlock.complete)) {
        const block = (async () => {
          if (cachedBlock?.kind === 'block') return cachedBlock;
          const value = await this.inflight.run(blockKey, ctx.signal, async (signal): Promise<CachedValue> => {
            if (sorted) await this.awaitConversion(state, signal);
            const ipc = await this.runArrow(state, topK(0, this.topKRows), where?.params, signal);
            const table = tableFromIPC(ipc);
            const result: CachedValue = { kind: 'block', table, complete: table.numRows < this.topKRows };
            this.results.set(blockKey, result, ipc.byteLength);
            return result;
          });
          if (value.kind !== 'block') throw new EngineFailure('query_failed', 'Unexpected cached value');
          return value;
        })();
        if (!(cachedBlock?.kind === 'block' && cachedBlock.complete)) {
          this.sortIndexes.ensure(
            {
              ...spec,
              before: async () => {
                const served = await block.catch(() => undefined);
                // Every row fits in the block: the view never needs the index.
                if (served?.complete) throw new EngineFailure('superseded', 'No index needed');
                await this.beforeBuild(state);
              },
            },
            ctx.viewId,
          );
        }
        const { table } = await block;
        return tableToIPC(table.slice(query.offset, end), 'stream');
      }
    }

    const release = await this.sortIndexes.acquire({ ...spec, before: () => this.beforeBuild(state) }, ctx.viewId, ctx.signal);
    try {
      const pageSql = `SELECT * EXCLUDE (${RN}) FROM ${name} WHERE ${RN} > ${intLiteral(query.offset)} AND ${RN} <= ${intLiteral(end)} ORDER BY ${RN}`;
      return await this.runArrow(state, pageSql, undefined, ctx.signal);
    } finally {
      release();
    }
  }

  /** Before an index build: prefer the Parquet copy, which sorts about twice as fast as the CSV. */
  private async beforeBuild(state: TableState): Promise<void> {
    if (state.source.kind === 'csv' && state.parquetMode !== 'never') this.parquetJob(state).promise.catch(() => undefined);
    await this.awaitConversion(state, undefined);
  }

  /**
   * Chart aggregate: run a full SELECT compiled by `compileChartQuery` over
   * this table's view (see `viewName`) and return Arrow IPC. Results are
   * cached by SQL, bound values, `pixelWidth` and type overrides.
   */
  async aggregate(
    id: TableId,
    compiled: SqlFragment,
    options: { pixelWidth?: number | undefined } = {},
    ctx: RequestContext = {},
  ): Promise<Cached<Uint8Array>> {
    const state = await this.table(id, ctx); // opens (or reopens) the view the SQL reads from
    const key = this.key(state, ['sql', fragmentKey(compiled), options.pixelWidth ?? null]);
    return this.cachedArrow(key, ctx, async (signal) => {
      await this.awaitConversion(state, signal);
      return this.runArrow(state, compiled.sql, compiled.params, signal);
    });
  }

  /**
   * Run a compiled query that returns one BIGINT in its first column (e.g.
   * `compileScatterCountQuery`) and return it as a number. Cached like counts.
   */
  async countQuery(id: TableId, compiled: SqlFragment, ctx: RequestContext = {}): Promise<Cached<number>> {
    const state = await this.table(id, ctx);
    const key = this.key(state, ['countQuery', fragmentKey(compiled)]);
    const hit = this.results.get(key);
    if (hit?.kind === 'count') return { value: hit.rowCount, cached: true };
    const value = await this.inflight.run(key, ctx.signal, async (signal): Promise<CachedValue> => {
      await this.awaitConversion(state, signal);
      const rowCount = await this.withConnection(state, signal, async (connection) => {
        const reader = await connection.runAndReadAll(compiled.sql, bind(compiled.params));
        return toCount(reader.getRows()[0]?.[0] ?? null);
      });
      const result: CachedValue = { kind: 'count', rowCount };
      this.results.set(key, result, 64);
      return result;
    });
    return { value: expectCount(value), cached: false };
  }

  private indexSpec(state: TableState, name: string, orderBy: string, where: SqlFragment | undefined): BuildSpec {
    const filter = where ? ` WHERE (${where.sql})` : '';
    return {
      name,
      tableId: state.id,
      connect: () => state.db.connect(),
      sql:
        `CREATE OR REPLACE TABLE ${name} AS SELECT row_number() OVER (ORDER BY ${orderBy}) AS ${RN}, * EXCLUDE (${ORD}) ` +
        `FROM ${state.ordView}${filter} ORDER BY ${RN}`,
      params: where?.params ?? [],
    };
  }

  private orderByClause(state: TableState, sort: readonly SortKey[]): string {
    const known = new Set(state.columns.map((column) => column.name));
    const keys = sort.map((key) => {
      if (!known.has(key.column)) throw new EngineFailure('unknown_column', `No column named "${key.column}"`);
      // NULLs last in both directions, matching the compiler's compileRowsQuery.
      return `${quoteIdent(key.column)} ${key.direction.toUpperCase()} NULLS LAST`;
    });
    keys.push(`${ORD} ASC`);
    return keys.join(', ');
  }

  /** Result-cache key: table, file content, type overrides and the request's logical inputs. */
  private key(state: TableState, parts: unknown[]): string {
    return ResultCache.key(state.id, `${state.fingerprint.key}:${state.version}`, JSON.stringify(parts));
  }

  private async cachedArrow(
    key: string,
    ctx: RequestContext,
    compute: (signal: AbortSignal) => Promise<Uint8Array>,
  ): Promise<Cached<Uint8Array>> {
    const hit = this.results.get(key);
    if (hit?.kind === 'ipc') return { value: hit.ipc, cached: true };
    const value = await this.inflight.run(key, ctx.signal, async (signal): Promise<CachedValue> => {
      const ipc = await compute(signal);
      const result: CachedValue = { kind: 'ipc', ipc };
      this.results.set(key, result, ipc.byteLength);
      return result;
    });
    if (value.kind !== 'ipc') throw new EngineFailure('query_failed', 'Unexpected cached value');
    return { value: value.ipc, cached: false };
  }

  private runArrow(
    state: TableState,
    sql: string,
    params: readonly SqlParam[] | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Uint8Array> {
    return this.withConnection(state, signal, async (connection) =>
      readerToArrowIPC(await connection.runAndReadAll(sql, bind(params))),
    );
  }

  // -------------------------------------------------------------------------
  // Parquet cache

  /**
   * Make sure the table reads a Parquet copy of its CSV, converting it if
   * needed. Conversion runs on its own connection and reports progress
   * events; queries keep using the CSV view until the copy is committed,
   * then the views switch over.
   */
  async ensureParquetCache(id: TableId): Promise<ParquetCacheOutcome> {
    const state = await this.table(id, {});
    const { entry, alreadyCached } = await this.parquetJob(state).promise;
    return { table: this.handleFor(state), alreadyCached, sizeBytes: entry.sizeBytes };
  }

  /** The table's Parquet job (shared by every table with the same content), started on demand. */
  private parquetJob(state: TableState): ParquetJob {
    const key = state.fingerprint.key;
    const running = this.parquetJobs.get(key);
    if (running) return running;
    const job: ParquetJob = {
      promise: (async () => {
        if (state.source.kind === 'parquet') {
          const info = await stat(state.source.path).catch(() => undefined);
          if (info) return { entry: { key, path: state.source.path, sizeBytes: info.size }, alreadyCached: true };
        }
        const existing = await this.parquetCache.lookup(key);
        if (existing) {
          await this.switchToParquet(key, existing, false);
          return { entry: existing, alreadyCached: true };
        }
        const started = performance.now();
        let entry: CacheEntry;
        try {
          entry = await this.convert(state);
        } catch (error) {
          const failure = toEngineFailure(error);
          for (const table of this.tablesWithKey(key)) {
            this.emit('event', { type: 'parquetFailed', table: table.id, code: failure.code, message: failure.message });
          }
          throw failure;
        }
        await this.switchToParquet(key, entry, true, performance.now() - started);
        return { entry, alreadyCached: false };
      })().finally(() => {
        if (this.parquetJobs.get(key) === job) this.parquetJobs.delete(key);
      }),
    };
    this.parquetJobs.set(key, job);
    return job;
  }

  /**
   * Wait for a running Parquet conversion of this table, if any. Queries
   * that scan the whole table call this first: a full CSV scan costs about
   * as much as the conversion itself, both compete for the same cores, and
   * the query runs several times faster on the copy.
   */
  private async awaitConversion(state: TableState, signal: AbortSignal | undefined): Promise<void> {
    const job = this.parquetJobs.get(state.fingerprint.key);
    if (!job) return;
    await raceAbort(
      job.promise.then(
        () => undefined,
        () => undefined,
      ),
      signal,
    );
  }

  /** For deep CSV pages: start the conversion (unless `never`) and wait for it. */
  private async preferParquet(state: TableState, signal: AbortSignal | undefined): Promise<void> {
    if (state.parquetMode !== 'never') this.parquetJob(state).promise.catch(() => undefined);
    await this.awaitConversion(state, signal);
  }

  private convert(state: TableState): Promise<CacheEntry> {
    const key = state.fingerprint.key;
    let active: DuckDBConnection | null = null;
    const flags = { interrupted: false };
    this.conversions.set(key, {
      interrupt: () => {
        flags.interrupted = true;
        active?.interrupt();
      },
    });
    return (async () => {
      await this.parquetCache.ready();
      const tempPath = this.parquetCache.tempPathFor(key);
      const connection = await state.db.connect();
      active = connection;
      if (flags.interrupted) connection.interrupt();
      let lastFraction: number | null = -1;
      const timer = setInterval(() => {
        const percentage = connection.progress.percentage;
        const fraction = percentage < 0 ? null : Math.min(1, Math.max(0, percentage / 100));
        if (fraction === lastFraction) return;
        lastFraction = fraction;
        for (const table of this.tablesWithKey(key)) {
          this.emit('event', { type: 'parquetProgress', table: table.id, fraction });
        }
      }, PROGRESS_INTERVAL_MS);
      try {
        // PRAGMAs, unlike SET, still work after lock_configuration; they only touch this connection.
        await connection.run('PRAGMA enable_progress_bar');
        await connection.run('PRAGMA disable_print_progress_bar');
        if (flags.interrupted) throw new EngineFailure('cancelled', 'Parquet conversion was cancelled');
        await connection.run(
          `COPY (SELECT * FROM ${await this.csvReader(connection, state)}) TO ${quoteLiteral(tempPath)} (FORMAT parquet, COMPRESSION zstd)`,
        );
        // The CSV may have changed while it was being copied; never cache a mix.
        const after = await fingerprintFile(state.csvPath);
        if (after.key !== key) throw new EngineFailure('io_failed', 'The file changed during conversion');
        return await this.parquetCache.commit(key, tempPath, this.keysInUse());
      } catch (error) {
        await this.parquetCache.discardTemp(tempPath).catch(() => undefined);
        if (isInterruptError(error)) throw new EngineFailure('cancelled', 'Parquet conversion was cancelled');
        throw error;
      } finally {
        clearInterval(timer);
        active = null;
        connection.closeSync();
      }
    })().finally(() => this.conversions.delete(key));
  }

  /**
   * Redefines a table's views one at a time. createViews reads the overrides and the source between
   * awaits, so a type change and the Parquet switch redefining them at once could leave the views with
   * the casts of a type change that was already undone (seen when the Parquet copy landed during an undo).
   * Only the redefinition is locked, not the scans before it, so a type change waiting for the
   * conversion does not wait for itself.
   */
  private withViewLock<T>(state: TableState, change: () => Promise<T>): Promise<T> {
    const run = state.viewLock.then(change);
    state.viewLock = run.catch(() => undefined);
    return run;
  }

  private async switchToParquet(key: string, entry: CacheEntry, emit: boolean, engineMs = 0): Promise<void> {
    for (const state of this.tablesWithKey(key)) {
      if (state.source.kind === 'parquet' && state.source.path === entry.path) continue;
      state.source = { kind: 'parquet', path: entry.path, key };
      await this.withViewLock(state, () =>
        this.withConnection(state, undefined, async (connection) => {
          await this.createViews(connection, state);
          const counted = await connection.runAndReadAll(`SELECT count(*) FROM ${state.rawView}`);
          state.rowCount = toCount(counted.getRows()[0]?.[0] ?? null);
        }),
      );
      if (emit) {
        this.emit('event', { type: 'parquetReady', table: this.handleFor(state), sizeBytes: entry.sizeBytes, engineMs });
      } else {
        this.emit('event', { type: 'tableUpdated', table: this.handleFor(state) });
      }
    }
  }

  private tablesWithKey(key: string): TableState[] {
    return [...this.tables.values()].filter((state) => state.fingerprint.key === key);
  }

  private keysInUse(): Set<string> {
    const keys = new Set<string>();
    for (const state of this.tables.values()) if (state.source.kind === 'parquet') keys.add(state.source.key);
    return keys;
  }

  // -------------------------------------------------------------------------
  // Cache management

  async clearCache(scope: CacheScope = 'all'): Promise<void> {
    if (scope === 'results' || scope === 'all') {
      this.results.clear();
      for (const state of this.tables.values()) {
        state.stats.clear();
        state.failedCasts.clear();
      }
    }
    if (scope === 'all') await this.sortIndexes.drop();
    if (scope === 'parquet' || scope === 'all') {
      for (const conversion of this.conversions.values()) conversion.interrupt();
      // Point tables back at their CSVs before their Parquet files disappear.
      for (const state of this.tables.values()) {
        if (state.source.kind !== 'parquet') continue;
        state.source = { kind: 'csv' };
        await this.withViewLock(state, () => this.withConnection(state, undefined, (connection) => this.createViews(connection, state)));
        this.emit('event', { type: 'tableUpdated', table: this.handleFor(state) });
      }
      await this.parquetCache.clear();
    }
  }

  resultCacheStats(): ResultCacheStats {
    return this.results.stats();
  }

  parquetCacheStats(): Promise<ParquetCacheStats> {
    return this.parquetCache.stats();
  }

  /** A renderer connection closed: its views no longer need their sort indexes. */
  releaseViews(prefix: string): void {
    this.sortIndexes.detachViews(prefix);
  }

  /** Counters for tests and diagnostics. */
  debugState(): { tables: number; sortIndexes: number; conversions: number; inflight: number; coalesced: number } {
    return {
      tables: this.tables.size,
      sortIndexes: this.sortIndexes.size,
      conversions: this.conversions.size,
      inflight: this.inflight.size,
      coalesced: this.inflight.joinedCount,
    };
  }

  /**
   * Forget a table: drop its indexes and cached results and close its DuckDB
   * instance. Its id reopens on demand while the file stays registered.
   */
  async closeTable(id: TableId): Promise<void> {
    const state = this.tables.get(id);
    if (!state) return;
    await state.typeChange;
    if (this.tables.get(id) !== state) return;
    this.tables.delete(id);
    this.results.invalidateTable(id);
    await this.sortIndexes.drop(id);
    if (!this.tablesWithKey(state.fingerprint.key).length) this.conversions.get(state.fingerprint.key)?.interrupt();
    await this.parquetJobs.get(state.fingerprint.key)?.promise.catch(() => undefined);
    // Queries still running on the instance are interrupted (their callers see an error) before it closes.
    state.closed = true;
    for (const connection of state.active) connection.interrupt();
    for (let waited = 0; state.active.size > 0 && waited < 5_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    state.db.closeSync();
    await removeTempDirectory(state.tempDir);
  }

  /**
   * A renderer session uses `id`. A table stays open while any session holds
   * it, so one window closing a file does not close it under another.
   */
  retainTable(id: TableId, holder: string): void {
    let holders = this.holders.get(id);
    if (!holders) {
      holders = new Set();
      this.holders.set(id, holders);
    }
    holders.add(holder);
  }

  /**
   * `holder` is done with `id` (it opened another file, or its window
   * closed). The last holder's release closes the table and frees its DuckDB
   * instance; the id still reopens on demand while the file is registered
   * (undo back to it). Resolves true when the table was closed.
   */
  async releaseTable(id: TableId, holder: string): Promise<boolean> {
    const holders = this.holders.get(id);
    if (!holders?.delete(holder)) return false;
    if (holders.size > 0) return false;
    this.holders.delete(id);
    await this.closeTable(id);
    return true;
  }

  /** Releases every table `holder` holds (its connection closed). */
  async releaseHolder(holder: string): Promise<void> {
    const held = [...this.holders].filter(([, holders]) => holders.has(holder)).map(([id]) => id);
    await Promise.all(held.map((id) => this.releaseTable(id, holder)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const conversion of this.conversions.values()) conversion.interrupt();
    for (const state of this.tables.values()) {
      state.db.closeSync();
      void removeTempDirectory(state.tempDir);
    }
    this.tables.clear();
  }

  // -------------------------------------------------------------------------

  private async withConnection<T>(
    state: TableState,
    signal: AbortSignal | undefined,
    fn: (connection: DuckDBConnection) => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    if (this.closed) throw new EngineFailure('engine_unavailable', 'The engine is shutting down');
    if (state.closed) throw new EngineFailure('unknown_table', 'This table was closed');
    const connection = await state.db.connect();
    const onAbort = () => connection.interrupt();
    signal?.addEventListener('abort', onAbort, { once: true });
    state.active.add(connection);
    try {
      throwIfAborted(signal);
      return await fn(connection);
    } catch (error) {
      throw toEngineFailure(error, signal);
    } finally {
      state.active.delete(connection);
      signal?.removeEventListener('abort', onAbort);
      connection.closeSync();
    }
  }

  /** Spill folders left behind by a crashed engine (instances remove their own on close). */
  private async removeStaleTempDirs(): Promise<void> {
    const names = await readdir(this.tempRoot).catch(() => [] as string[]);
    const now = Date.now();
    await Promise.all(
      names
        .filter((name) => name.startsWith('tb_'))
        .map(async (name) => {
          const path = join(this.tempRoot, name);
          const info = await stat(path).catch(() => undefined);
          if (info && now - info.mtimeMs > STALE_TEMP_DIR_MS && !this.tables.has(name as TableId)) {
            await removeTempDirectory(path);
          }
        }),
    );
  }
}

function statKey(column: string, duckdbType: string): string {
  return `${column}\u0000${duckdbType}`;
}

function statSelects(expression: string): string[] {
  return [`count(${expression})`, `approx_count_distinct(${expression})`, `min(${expression})`, `max(${expression})`];
}

function readStats(row: readonly DuckDBValue[], base: number, rowCount: number): ColumnStats {
  const nonNull = toCount(row[base] ?? null);
  return {
    nullFraction: rowCount === 0 ? 0 : (rowCount - nonNull) / rowCount,
    distinctCount: toCount(row[base + 1] ?? null),
    min: toScalar(row[base + 2] ?? null),
    max: toScalar(row[base + 3] ?? null),
  };
}

/** The profile from cached per-column statistics, or null if any column is missing. */
function assembleProfile(state: TableState): TableProfile | null {
  if (state.rowCount === undefined) return null;
  const columns: TableColumnProfile[] = [];
  for (const column of state.columns) {
    const stats = state.stats.get(statKey(column.name, column.duckdbType));
    if (!stats) return null;
    columns.push({ ...column, ...stats });
  }
  return { rowCount: state.rowCount, columns };
}

function sameOverrides(a: ReadonlyMap<string, ColumnType>, b: ReadonlyMap<string, ColumnType>): boolean {
  if (a.size !== b.size) return false;
  for (const [column, type] of a) if (b.get(column) !== type) return false;
  return true;
}

function expectCount(value: CachedValue): number {
  if (value.kind !== 'count') throw new EngineFailure('query_failed', 'Unexpected cached value');
  return value.rowCount;
}

/**
 * Sniff a CSV once (the same detection `read_csv_auto` runs at every bind)
 * and spell the result out as an explicit `read_csv(...)` call, mirroring
 * the options of DuckDB's own `sniff_csv(...).Prompt`. Falls back to
 * `read_csv_auto` if sniffing fails, so DuckDB reports the real error on use.
 */
async function sniffCsvReader(connection: DuckDBConnection, path: string): Promise<string> {
  const fallback = `read_csv_auto(${quoteLiteral(path)})`;
  let row: Record<string, DuckDBValue> | undefined;
  try {
    row = (await connection.runAndReadAll('SELECT * FROM sniff_csv(?)', [path])).getRowObjects()[0];
  } catch (error) {
    if (isInterruptError(error)) throw error;
    return fallback;
  }
  if (!row) return fallback;
  const text = (name: string): string => {
    const value = row[name];
    return value === null || value === undefined || String(value) === '(empty)' ? '' : String(value);
  };
  const columns = row['Columns'];
  if (!(columns instanceof DuckDBListValue) || columns.items.length === 0) return fallback;
  const columnDefs = columns.items.map((item) => {
    if (!(item instanceof DuckDBStructValue)) throw new Error('Unexpected sniff_csv column entry');
    return `${quoteLiteral(String(item.entries['name']))}: ${quoteLiteral(String(item.entries['type']))}`;
  });
  const options = [
    'auto_detect = false',
    `delim = ${quoteLiteral(text('Delimiter'))}`,
    `quote = ${quoteLiteral(text('Quote'))}`,
    `escape = ${quoteLiteral(text('Escape'))}`,
    `new_line = ${quoteLiteral(text('NewLineDelimiter'))}`,
    `skip = ${intLiteral(Number(row['SkipRows'] ?? 0))}`,
    `comment = ${quoteLiteral(text('Comment'))}`,
    `header = ${row['HasHeader'] === true ? 'true' : 'false'}`,
    `columns = {${columnDefs.join(', ')}}`,
  ];
  if (text('DateFormat')) options.push(`dateformat = ${quoteLiteral(text('DateFormat'))}`);
  if (text('TimestampFormat')) options.push(`timestampformat = ${quoteLiteral(text('TimestampFormat'))}`);
  return `read_csv(${quoteLiteral(path)}, ${options.join(', ')})`;
}

function bind(params: readonly SqlParam[] | undefined): SqlParam[] | undefined {
  return params && params.length > 0 ? [...params] : undefined;
}

/** Deterministic, so a rebuilt index gets the same name and cached pages stay valid. */
function sortIndexName(state: TableState, orderBy: string, where: SqlFragment | undefined): string {
  const digest = createHash('sha256')
    .update(state.version)
    .update('\u0000')
    .update(orderBy)
    .update('\u0000')
    .update(fragmentKey(where))
    .digest('hex');
  return quoteIdent(`gg_idx_${state.id}_${digest.slice(0, 16)}`);
}

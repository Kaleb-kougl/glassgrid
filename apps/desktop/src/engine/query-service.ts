import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
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
  type TableColumnProfile,
  type EngineEvent,
  type FileHandle,
  type Fingerprint,
  type ParquetCacheStats,
  type ParquetMode,
  type ResultCacheStats,
  type RowsQuery,
  type SortKey,
  type TableHandle,
  type TableId,
} from '@glassgrid/core';
import { readerToArrowIPC } from './arrow';
import { simpleColumnType, toCount, toScalar } from './column-types';
import {
  EngineFailure,
  errorMessage,
  isInterruptError,
  throwIfAborted,
  toEngineFailure,
} from './errors';
import { fingerprintFile } from './fingerprint';
import { DEFAULT_PARQUET_CACHE_BYTES, ParquetCache, type CacheEntry } from './parquet-cache';
import { DEFAULT_RESULT_CACHE_BYTES, ResultCache } from './result-cache';
import { DEFAULT_MAX_SORT_INDEXES, SortIndexes } from './sort-indexes';
import { fragmentKey, intLiteral, quoteIdent, quoteLiteral, type SqlFragment, type SqlParam } from './sql-text';

export const DEFAULT_AUTO_CONVERT_MIN_BYTES = 200 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;

/** Hidden columns the engine adds; user columns with these names are not supported. */
const ORD = '__gg_ord';
const RN = '__gg_rn';

export interface QueryServiceOptions {
  /** Parquet cache folder (main passes `<userData>/cache/parquet`). */
  cacheDir: string;
  parquetCacheMaxBytes?: number;
  autoConvertMinBytes?: number;
  resultCacheMaxBytes?: number;
  /** DuckDB spill folder; defaults to `<cacheDir>/../duckdb-tmp`. */
  tempDir?: string;
  maxSortIndexes?: number;
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

type Source = { kind: 'csv' } | { kind: 'parquet'; path: string; key: string };

interface TableState {
  id: TableId;
  file: FileHandle;
  csvPath: string;
  /**
   * `read_csv(...)` with the dialect and column types sniffed once at open
   * (null until first needed). Spelling the options out means later queries
   * bind without re-sniffing the file, which otherwise costs 30-60 ms each.
   */
  csvReader: string | null;
  fingerprint: Fingerprint;
  source: Source;
  columns: ColumnInfo[];
  rowCount: number | undefined;
  /** View exposing the user's columns. */
  view: string;
  /** Same rows plus `__gg_ord`, the 0-based position in the file. */
  ordView: string;
}

type CachedValue =
  | { kind: 'ipc'; ipc: Uint8Array }
  | { kind: 'count'; rowCount: number }
  | { kind: 'profile'; profile: TableProfile };

interface QueryServiceEvents {
  event: [EngineEvent];
}

/**
 * The engine's query layer: tables over CSV/Parquet files, profiles, grid
 * pages, counts, the Parquet cache and the result cache. It is plain Node
 * (no Electron), so Vitest drives it against real DuckDB.
 *
 * Every request runs on its own DuckDB connection, and `ctx.signal` maps to
 * `connection.interrupt()`, which DuckDB honours within milliseconds.
 */
export class QueryService extends EventEmitter<QueryServiceEvents> {
  private readonly files = new Map<FileHandle, string>();
  private readonly tables = new Map<TableId, TableState>();
  private readonly opening = new Map<TableId, Promise<TableState>>();
  private readonly conversions = new Map<string, { promise: Promise<CacheEntry>; interrupt: () => void }>();
  private readonly results: ResultCache<CachedValue>;
  private readonly sortIndexes: SortIndexes;
  readonly parquetCache: ParquetCache;
  private readonly autoConvertMinBytes: number;
  private closed = false;

  private constructor(
    private readonly db: DuckDBInstance,
    options: QueryServiceOptions,
  ) {
    super();
    this.parquetCache = new ParquetCache(options.cacheDir, options.parquetCacheMaxBytes ?? DEFAULT_PARQUET_CACHE_BYTES);
    this.results = new ResultCache(options.resultCacheMaxBytes ?? DEFAULT_RESULT_CACHE_BYTES);
    this.sortIndexes = new SortIndexes(() => this.db.connect(), options.maxSortIndexes ?? DEFAULT_MAX_SORT_INDEXES);
    this.autoConvertMinBytes = options.autoConvertMinBytes ?? DEFAULT_AUTO_CONVERT_MIN_BYTES;
  }

  static async create(options: QueryServiceOptions): Promise<QueryService> {
    const db = await DuckDBInstance.create(':memory:', {
      // An offline desktop app must never fetch extensions behind the user's back.
      autoinstall_known_extensions: 'false',
      // Unsorted pages and file-order tie-breaks rely on scans keeping file order.
      preserve_insertion_order: 'true',
      temp_directory: options.tempDir ?? join(dirname(options.cacheDir), 'duckdb-tmp'),
    });
    return new QueryService(db, options);
  }

  // -------------------------------------------------------------------------
  // Files and tables

  /**
   * Name of the view that exposes a table's columns (unquoted). The chart
   * compiler reads from it: `compileChartQuery(quoteIdent(viewName), ...)`.
   * Deterministic, so it is valid as soon as the table is open.
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
   * Open a registered file as a table: a view over `read_csv_auto`, or over
   * the cached Parquet copy when one matches the file's fingerprint.
   * Idempotent; reopening a file whose content changed rebuilds the view and
   * drops its cached results.
   */
  async open(file: FileHandle, options: { parquet?: ParquetMode } = {}, ctx: RequestContext = {}): Promise<TableHandle> {
    const csvPath = this.files.get(file);
    if (!csvPath) throw new EngineFailure('unknown_handle', 'This file is no longer open');
    const id = tableIdForFile(file);

    const state = await this.openTable(id, file, csvPath, ctx);
    const mode = options.parquet ?? 'auto';
    if (
      state.source.kind === 'csv' &&
      (mode === 'always' || (mode === 'auto' && state.fingerprint.sizeBytes >= this.autoConvertMinBytes))
    ) {
      // Background conversion; progress and completion arrive as events.
      this.ensureParquetCache(id).catch(() => undefined);
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

    const cached = await this.parquetCache.lookup(fingerprint.key).catch(() => undefined);
    const source: Source = cached ? { kind: 'parquet', path: cached.path, key: cached.key } : { kind: 'csv' };
    const state: TableState = {
      id,
      file,
      csvPath,
      csvReader: null,
      fingerprint,
      source,
      columns: [],
      rowCount: undefined,
      view: quoteIdent(QueryService.viewName(id)),
      ordView: quoteIdent(`gg_${id}_ord`),
    };

    await this.withConnection(ctx.signal, async (connection) => {
      await this.createViews(connection, state);
      const described = await connection.runAndReadAll(`DESCRIBE SELECT * FROM ${state.view}`);
      state.columns = described.getRowObjects().map((row) => {
        const name = String(row['column_name']);
        const duckdbType = String(row['column_type']);
        return { name, duckdbType, type: simpleColumnType(duckdbType) };
      });
      if (state.columns.some((column) => column.name === ORD || column.name === RN)) {
        throw new EngineFailure('query_failed', `Columns named ${ORD} or ${RN} are reserved`);
      }
      if (source.kind === 'parquet') {
        // Parquet row counts come from file metadata, so this is cheap.
        const counted = await connection.runAndReadAll(`SELECT count(*) FROM ${state.view}`);
        state.rowCount = toCount(counted.getRows()[0]?.[0] ?? null);
      }
    });

    this.tables.set(id, state);
    return state;
  }

  private async createViews(connection: DuckDBConnection, state: TableState): Promise<void> {
    if (state.source.kind === 'parquet') {
      const parquet = `read_parquet(${quoteLiteral(state.source.path)}, file_row_number = true)`;
      await connection.run(`CREATE OR REPLACE VIEW ${state.view} AS SELECT * EXCLUDE (file_row_number) FROM ${parquet}`);
      await connection.run(
        `CREATE OR REPLACE VIEW ${state.ordView} AS SELECT file_row_number AS ${ORD}, * EXCLUDE (file_row_number) FROM ${parquet}`,
      );
    } else {
      const csv = await this.csvReader(connection, state);
      await connection.run(`CREATE OR REPLACE VIEW ${state.view} AS SELECT * FROM ${csv}`);
      // With preserve_insertion_order, an empty OVER () numbers rows in file order.
      await connection.run(
        `CREATE OR REPLACE VIEW ${state.ordView} AS SELECT (row_number() OVER ()) - 1 AS ${ORD}, * FROM ${csv}`,
      );
    }
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

  /** A table's columns (name, logical type, DuckDB type), opening it on demand. */
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
    };
  }

  // -------------------------------------------------------------------------
  // Queries

  /**
   * Per-column profile in one aggregate scan: non-null count, approximate
   * distinct count (HyperLogLog), min and max. Cheaper than SUMMARIZE, which
   * also computes avg, stddev and three quantiles (see docs/m1-engine-notes.md).
   */
  async profile(id: TableId, ctx: RequestContext = {}): Promise<Cached<TableProfile>> {
    const state = await this.table(id, ctx);
    const selects = ['count(*)'];
    for (const column of state.columns) {
      const c = quoteIdent(column.name);
      selects.push(`count(${c})`, `approx_count_distinct(${c})`, `min(${c})`, `max(${c})`);
    }
    const sql = `SELECT ${selects.join(', ')} FROM ${state.view}`;
    const key = ResultCache.key(id, sql, '');
    const hit = this.results.get(key);
    if (hit?.kind === 'profile') return { value: hit.profile, cached: true };

    const row = await this.withConnection(ctx.signal, async (connection) => {
      const reader = await connection.runAndReadAll(sql);
      return reader.getRows()[0] ?? [];
    });
    const rowCount = toCount(row[0] ?? null);
    const columns = state.columns.map((column, index): TableColumnProfile => {
      const base = 1 + index * 4;
      const nonNull = toCount(row[base] ?? null);
      return {
        ...column,
        nullFraction: rowCount === 0 ? 0 : (rowCount - nonNull) / rowCount,
        distinctCount: toCount(row[base + 1] ?? null),
        min: toScalar(row[base + 2] ?? null),
        max: toScalar(row[base + 3] ?? null),
      };
    });
    state.rowCount = rowCount;
    const profile = { rowCount, columns };
    this.results.set(key, { kind: 'profile', profile }, JSON.stringify(profile).length * 2);
    return { value: profile, cached: false };
  }

  /** Row count, optionally filtered by a compiled WHERE fragment. */
  async count(id: TableId, where?: SqlFragment, ctx: RequestContext = {}): Promise<Cached<number>> {
    const state = await this.table(id, ctx);
    const sql = `SELECT count(*) FROM ${state.view}${where ? ` WHERE (${where.sql})` : ''}`;
    const key = ResultCache.key(id, sql, fragmentKey(where));
    const hit = this.results.get(key);
    if (hit?.kind === 'count') return { value: hit.rowCount, cached: true };

    const rowCount = await this.withConnection(ctx.signal, async (connection) => {
      const reader = await connection.runAndReadAll(sql, bind(where?.params));
      return toCount(reader.getRows()[0]?.[0] ?? null);
    });
    if (!where) state.rowCount = rowCount;
    this.results.set(key, { kind: 'count', rowCount }, 64);
    return { value: rowCount, cached: false };
  }

  /**
   * One grid page as Arrow IPC.
   *
   * - Unsorted and unfiltered: file order. On Parquet the page is a range
   *   predicate on `file_row_number` (row groups are skipped via
   *   statistics); on CSV it is LIMIT/OFFSET, which DuckDB returns in file
   *   order because insertion order is preserved.
   * - Sorted and/or filtered: a row-number table is materialized once per
   *   (table, sort, filter) and paged by `__gg_rn` range. Ties fall back to
   *   file order, so paging is deterministic.
   */
  async rows(id: TableId, query: RowsOptions, ctx: RequestContext = {}): Promise<Cached<Uint8Array>> {
    const state = await this.table(id, ctx);
    const sort = query.sort ?? [];
    const orderBy = this.orderByClause(state, sort);
    const first = query.offset;
    const end = query.offset + query.limit;

    if (sort.length === 0 && !query.where) {
      if (ctx.viewId !== undefined) this.sortIndexes.detachView(ctx.viewId);
      const sql =
        state.source.kind === 'parquet'
          ? `SELECT * EXCLUDE (${ORD}) FROM ${state.ordView} WHERE ${ORD} >= ${intLiteral(first)} AND ${ORD} < ${intLiteral(end)} ORDER BY ${ORD}`
          : `SELECT * FROM ${state.view} LIMIT ${intLiteral(query.limit)} OFFSET ${intLiteral(first)}`;
      return this.cachedArrow(id, sql, undefined, ctx);
    }

    const where = query.where;
    const name = sortIndexName(id, orderBy, where);
    const pageSql = `SELECT * EXCLUDE (${RN}) FROM ${name} WHERE ${RN} > ${intLiteral(first)} AND ${RN} <= ${intLiteral(end)} ORDER BY ${RN}`;
    const key = ResultCache.key(id, pageSql, '');
    const hit = this.results.get(key);
    if (hit?.kind === 'ipc') {
      // Keep the view attached to its index so a build in progress is not abandoned.
      if (ctx.viewId !== undefined) this.sortIndexes.touch(name, ctx.viewId);
      return { value: hit.ipc, cached: true };
    }

    const release = await this.sortIndexes.acquire(this.indexSpec(state, name, orderBy, where), ctx.viewId, ctx.signal);
    try {
      return await this.cachedArrow(id, pageSql, undefined, ctx);
    } finally {
      release();
    }
  }

  /**
   * Chart aggregate: run a full SELECT compiled by `compileChartQuery` over
   * this table's view (see `viewName`) and return Arrow IPC. Results are
   * cached by SQL, bound values and `pixelWidth`.
   */
  async aggregate(
    id: TableId,
    compiled: SqlFragment,
    options: { pixelWidth?: number | undefined } = {},
    ctx: RequestContext = {},
  ): Promise<Cached<Uint8Array>> {
    await this.table(id, ctx); // opens (or reopens) the view the SQL reads from
    return this.cachedArrow(id, compiled.sql, compiled, ctx, `pixelWidth=${options.pixelWidth ?? 'default'}`);
  }

  /**
   * Run a compiled query that returns one BIGINT in its first column (e.g.
   * `compileScatterCountQuery`) and return it as a number. Cached like counts.
   */
  async countQuery(id: TableId, compiled: SqlFragment, ctx: RequestContext = {}): Promise<Cached<number>> {
    await this.table(id, ctx);
    const key = ResultCache.key(id, compiled.sql, fragmentKey(compiled));
    const hit = this.results.get(key);
    if (hit?.kind === 'count') return { value: hit.rowCount, cached: true };
    const rowCount = await this.withConnection(ctx.signal, async (connection) => {
      const reader = await connection.runAndReadAll(compiled.sql, bind(compiled.params));
      return toCount(reader.getRows()[0]?.[0] ?? null);
    });
    this.results.set(key, { kind: 'count', rowCount }, 64);
    return { value: rowCount, cached: false };
  }

  private indexSpec(state: TableState, name: string, orderBy: string, where: SqlFragment | undefined) {
    const filter = where ? ` WHERE (${where.sql})` : '';
    return {
      name,
      tableId: state.id,
      sql:
        `CREATE TABLE ${name} AS SELECT row_number() OVER (ORDER BY ${orderBy}) AS ${RN}, * EXCLUDE (${ORD}) ` +
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

  private async cachedArrow(
    id: TableId,
    sql: string,
    where: SqlFragment | undefined,
    ctx: RequestContext,
    /** Extra cache-key material for inputs that shape the result but not the SQL text. */
    keyExtra = '',
  ): Promise<Cached<Uint8Array>> {
    const key = ResultCache.key(id, sql, keyExtra ? `${fragmentKey(where)}\u0000${keyExtra}` : fragmentKey(where));
    const hit = this.results.get(key);
    if (hit?.kind === 'ipc') return { value: hit.ipc, cached: true };
    const ipc = await this.withConnection(ctx.signal, async (connection) =>
      readerToArrowIPC(await connection.runAndReadAll(sql, bind(where?.params))),
    );
    this.results.set(key, { kind: 'ipc', ipc }, ipc.byteLength);
    return { value: ipc, cached: false };
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
    if (state.source.kind === 'parquet') {
      const info = await stat(state.source.path).catch(() => undefined);
      if (info) return { table: this.handleFor(state), alreadyCached: true, sizeBytes: info.size };
    }

    const key = state.fingerprint.key;
    const existing = await this.parquetCache.lookup(key);
    if (existing) {
      await this.switchToParquet(key, existing, false);
      return { table: this.handleFor(state), alreadyCached: true, sizeBytes: existing.sizeBytes };
    }

    const started = performance.now();
    let entry: CacheEntry;
    try {
      entry = await this.convert(state);
    } catch (error) {
      const failure = toEngineFailure(error);
      this.emit('event', { type: 'parquetFailed', table: id, code: failure.code, message: failure.message });
      throw failure;
    }
    await this.switchToParquet(key, entry, true, performance.now() - started);
    return { table: this.handleFor(state), alreadyCached: false, sizeBytes: entry.sizeBytes };
  }

  private convert(state: TableState): Promise<CacheEntry> {
    const key = state.fingerprint.key;
    const running = this.conversions.get(key);
    if (running) return running.promise;

    let active: DuckDBConnection | null = null;
    const flags = { interrupted: false };
    const promise = (async () => {
      await this.parquetCache.ready();
      const tempPath = this.parquetCache.tempPathFor(key);
      const connection = await this.db.connect();
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
        await connection.run('SET enable_progress_bar = true');
        await connection.run('SET enable_progress_bar_print = false');
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
    this.conversions.set(key, {
      promise,
      interrupt: () => {
        flags.interrupted = true;
        active?.interrupt();
      },
    });
    return promise;
  }

  private async switchToParquet(key: string, entry: CacheEntry, emit: boolean, engineMs = 0): Promise<void> {
    for (const state of this.tablesWithKey(key)) {
      if (state.source.kind === 'parquet' && state.source.path === entry.path) continue;
      state.source = { kind: 'parquet', path: entry.path, key };
      await this.withConnection(undefined, async (connection) => {
        await this.createViews(connection, state);
        const counted = await connection.runAndReadAll(`SELECT count(*) FROM ${state.view}`);
        state.rowCount = toCount(counted.getRows()[0]?.[0] ?? null);
      });
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
    if (scope === 'results' || scope === 'all') this.results.clear();
    if (scope === 'all') await this.sortIndexes.drop();
    if (scope === 'parquet' || scope === 'all') {
      for (const conversion of this.conversions.values()) conversion.interrupt();
      // Point tables back at their CSVs before their Parquet files disappear.
      for (const state of this.tables.values()) {
        if (state.source.kind !== 'parquet') continue;
        state.source = { kind: 'csv' };
        await this.withConnection(undefined, (connection) => this.createViews(connection, state));
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

  /** Counters for tests and diagnostics. */
  debugState(): { tables: number; sortIndexes: number; conversions: number } {
    return { tables: this.tables.size, sortIndexes: this.sortIndexes.size, conversions: this.conversions.size };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const conversion of this.conversions.values()) conversion.interrupt();
    this.db.closeSync();
  }

  // -------------------------------------------------------------------------

  private async withConnection<T>(
    signal: AbortSignal | undefined,
    fn: (connection: DuckDBConnection) => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    const connection = await this.db.connect();
    const onAbort = () => connection.interrupt();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      throwIfAborted(signal);
      return await fn(connection);
    } catch (error) {
      throw toEngineFailure(error, signal);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      connection.closeSync();
    }
  }
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
function sortIndexName(id: TableId, orderBy: string, where: SqlFragment | undefined): string {
  const digest = createHash('sha256').update(orderBy).update('\u0000').update(fragmentKey(where)).digest('hex');
  return quoteIdent(`gg_idx_${id}_${digest.slice(0, 16)}`);
}

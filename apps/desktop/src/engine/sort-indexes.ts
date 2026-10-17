import type { DuckDBConnection } from '@duckdb/node-api';
import type { SqlParam } from './sql-text';
import { EngineFailure, errorMessage, isInterruptError, raceAbort } from './errors';

export const DEFAULT_MAX_SORT_INDEXES = 4;

interface SortIndex {
  name: string;
  tableId: string;
  ready: Promise<void>;
  building: boolean;
  connection: DuckDBConnection | null;
  /** Views whose latest request needs this index. */
  views: Set<string>;
  /** In-flight requests without a view id (never superseded). */
  anonymous: number;
  /** Requests currently reading or awaiting the index. */
  refs: number;
}

export interface BuildSpec {
  /** Deterministic, already-quoted-safe table name (see QueryService.sortIndexName). */
  name: string;
  tableId: string;
  /** CREATE TABLE ... AS SELECT statement producing the index. */
  sql: string;
  params: readonly SqlParam[];
}

/**
 * Materialized row-number tables for sorted (and filtered) grid views.
 *
 * Each index is `CREATE TABLE <name> AS SELECT row_number() OVER (ORDER BY
 * <keys>, __gg_ord) AS __gg_rn, * ... ORDER BY __gg_rn`, built once per
 * (table, sort, filter) and paged with `__gg_rn` range predicates: rows are
 * stored in rn order, so DuckDB's zone maps skip straight to the page
 * instead of walking a deep OFFSET.
 *
 * Builds run on their own connection so a build is shared by every request
 * that needs it. A build is interrupted only when no view wants it any more
 * (its views moved on to another sort), not when a single page request is
 * superseded, because the next page request of the same view needs the
 * same index. Ready indexes are kept LRU up to `maxIndexes`.
 */
export class SortIndexes {
  private readonly indexes = new Map<string, SortIndex>();

  constructor(
    private readonly connect: () => Promise<DuckDBConnection>,
    private readonly maxIndexes = DEFAULT_MAX_SORT_INDEXES,
  ) {}

  /**
   * Ensure the index exists and hold a reference while the caller reads it.
   * Resolves with a release function.
   */
  async acquire(spec: BuildSpec, viewId: string | undefined, signal?: AbortSignal): Promise<() => void> {
    let index = this.indexes.get(spec.name);
    if (index) {
      // Refresh LRU position.
      this.indexes.delete(spec.name);
      this.indexes.set(spec.name, index);
    } else {
      index = this.startBuild(spec);
    }

    if (viewId === undefined) index.anonymous += 1;
    else this.attachView(viewId, index);
    index.refs += 1;

    const current = index;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      current.refs -= 1;
      if (viewId === undefined) current.anonymous -= 1;
      void this.trim();
    };

    try {
      await raceAbort(current.ready, signal);
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  /** The view now needs `index` (or no index at all): abandon its other builds. */
  attachView(viewId: string, index: SortIndex | null): void {
    for (const other of this.indexes.values()) {
      if (other === index || !other.views.delete(viewId)) continue;
      if (other.building && other.views.size === 0 && other.anonymous === 0) {
        other.connection?.interrupt();
      }
    }
    index?.views.add(viewId);
  }

  /** Attach a view to an existing index without holding a reference (cache hits). */
  touch(name: string, viewId: string): void {
    const index = this.indexes.get(name);
    if (index) this.attachView(viewId, index);
  }

  detachView(viewId: string): void {
    this.attachView(viewId, null);
  }

  /** Drop every index of a table (its source changed), or all indexes. */
  async drop(tableId?: string): Promise<void> {
    const victims = [...this.indexes.values()].filter((index) => tableId === undefined || index.tableId === tableId);
    for (const index of victims) {
      this.indexes.delete(index.name);
      index.connection?.interrupt();
    }
    await Promise.all(victims.map((index) => this.dropTable(index)));
  }

  get size(): number {
    return this.indexes.size;
  }

  private startBuild(spec: BuildSpec): SortIndex {
    const index: SortIndex = {
      name: spec.name,
      tableId: spec.tableId,
      ready: Promise.resolve(),
      building: true,
      connection: null,
      views: new Set(),
      anonymous: 0,
      refs: 0,
    };
    index.ready = (async () => {
      const connection = await this.connect();
      index.connection = connection;
      try {
        // An interrupt may have been requested before the connection existed.
        if (index.views.size === 0 && index.anonymous === 0 && index.refs === 0) {
          throw new EngineFailure('superseded', 'Sort index no longer needed');
        }
        await connection.run(`DROP TABLE IF EXISTS ${spec.name}`);
        await connection.run(spec.sql, spec.params.length > 0 ? [...spec.params] : undefined);
      } catch (error) {
        if (this.indexes.get(spec.name) === index) this.indexes.delete(spec.name);
        if (error instanceof EngineFailure) throw error;
        if (isInterruptError(error)) throw new EngineFailure('superseded', 'Sort index build was interrupted');
        throw new EngineFailure('query_failed', `Sorting failed: ${errorMessage(error)}`, { cause: error });
      } finally {
        index.building = false;
        index.connection = null;
        connection.closeSync();
      }
    })();
    // Failures surface through acquire(); keep an unobserved build from crashing the process.
    index.ready.catch(() => undefined);
    this.indexes.set(spec.name, index);
    void this.trim();
    return index;
  }

  /** Evict least recently used ready, unreferenced indexes beyond the cap. */
  private async trim(): Promise<void> {
    const excess = this.indexes.size - this.maxIndexes;
    if (excess <= 0) return;
    const victims: SortIndex[] = [];
    for (const index of this.indexes.values()) {
      if (victims.length >= excess) break;
      if (!index.building && index.refs === 0) victims.push(index);
    }
    for (const index of victims) this.indexes.delete(index.name);
    await Promise.all(victims.map((index) => this.dropTable(index)));
  }

  private async dropTable(index: SortIndex): Promise<void> {
    await index.ready.catch(() => undefined);
    // Rebuilt under the same name meanwhile: leave the new one alone.
    if (this.indexes.has(index.name)) return;
    try {
      const connection = await this.connect();
      try {
        if (!this.indexes.has(index.name)) await connection.run(`DROP TABLE IF EXISTS ${index.name}`);
      } finally {
        connection.closeSync();
      }
    } catch (error) {
      console.warn(`[engine] could not drop sort index ${index.name}: ${errorMessage(error)}`);
    }
  }
}

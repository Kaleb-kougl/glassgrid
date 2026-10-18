import type { DuckConnection } from './driver';
import type { SqlParam } from './sql-text';
import { EngineFailure, errorMessage, isInterruptError, raceAbort } from './errors';

export const DEFAULT_MAX_SORT_INDEXES = 4;

interface SortIndex {
  name: string;
  tableId: string;
  connect: () => Promise<DuckConnection>;
  ready: Promise<void>;
  building: boolean;
  /** Set once the table exists. */
  done: boolean;
  /** Set when the build was abandoned or failed; the entry is gone from the map. */
  dead: boolean;
  connection: DuckConnection | null;
  /** Kept alive although no view wants it (requested without a view id). */
  pinned: boolean;
  /** Requests currently reading or awaiting the index. */
  refs: number;
  /** Of those, requests without a view id (they are never superseded, so they keep the build alive). */
  anonymous: number;
}

export interface BuildSpec {
  /** Deterministic, already-quoted table name (see QueryService). */
  name: string;
  tableId: string;
  /** CREATE TABLE ... AS SELECT statement producing the index. */
  sql: string;
  params: readonly SqlParam[];
  /** Connection to the table's DuckDB instance. */
  connect: () => Promise<DuckConnection>;
  /**
   * Awaited before the build starts, e.g. until the top-K page that asked
   * for it has been served or a running Parquet conversion has finished.
   */
  before?: () => Promise<unknown>;
}

/**
 * Materialized row-number tables for sorted (and filtered) grid views.
 *
 * Each index is `CREATE TABLE <name> AS SELECT row_number() OVER (ORDER BY
 * <keys>, __gg_ord) AS __gg_rn, * ... ORDER BY __gg_rn`, built once per
 * (table, type overrides, sort, filter) and paged with `__gg_rn` range
 * predicates: rows are stored in rn order, so DuckDB's zone maps skip
 * straight to the page instead of walking a deep OFFSET.
 *
 * Builds run on their own connection, so one build serves every request
 * that needs it. Each view (`viewId`) wants at most one index at a time; a
 * build is interrupted only when no view wants it any more, no request holds
 * it and it was not pinned by a view-less request. The first pages of a
 * sorted view are served by top-K queries while its index builds in the
 * background (see QueryService.rows). Ready indexes are kept LRU up to
 * `maxIndexes`.
 */
export class SortIndexes {
  private readonly indexes = new Map<string, SortIndex>();
  /** viewId -> name of the index that view currently pages through. */
  private readonly wants = new Map<string, string>();

  constructor(private readonly maxIndexes = DEFAULT_MAX_SORT_INDEXES) {}

  isReady(name: string): boolean {
    return this.indexes.get(name)?.done === true;
  }

  /**
   * Make sure the index exists or is being built, without waiting for it.
   * The view (if any) now wants this index; a view-less call pins it.
   */
  ensure(spec: BuildSpec, viewId: string | undefined): void {
    const index = this.lookup(spec);
    if (viewId === undefined) index.pinned = true;
    else this.want(viewId, spec.name);
  }

  /**
   * Ensure the index exists and hold a reference while the caller reads it.
   * Resolves with a release function once the index is ready.
   */
  async acquire(spec: BuildSpec, viewId: string | undefined, signal?: AbortSignal): Promise<() => void> {
    const index = this.lookup(spec);
    if (viewId !== undefined) this.want(viewId, spec.name);
    else index.anonymous += 1;
    index.refs += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      index.refs -= 1;
      if (viewId === undefined) index.anonymous -= 1;
      if (!index.done && !this.wanted(index)) this.abandon(index);
      void this.trim();
    };
    try {
      await raceAbort(index.ready, signal);
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  /**
   * The view now pages through `name` (or through no index at all when null),
   * e.g. on a cache hit or an unsorted page. Builds nobody wants any more
   * are interrupted.
   */
  want(viewId: string, name: string | null): void {
    const previous = this.wants.get(viewId);
    if (previous === name) return;
    if (name === null) this.wants.delete(viewId);
    else this.wants.set(viewId, name);
    const old = previous === undefined ? undefined : this.indexes.get(previous);
    if (old && !old.done && !this.wanted(old)) this.abandon(old);
  }

  detachView(viewId: string): void {
    this.want(viewId, null);
  }

  /** Detach every view whose id starts with `prefix` (e.g. a closed window's session). */
  detachViews(prefix: string): void {
    for (const viewId of [...this.wants.keys()]) if (viewId.startsWith(prefix)) this.want(viewId, null);
  }

  /** Drop every index of a table (its data or column types changed), or all indexes. */
  async drop(tableId?: string): Promise<void> {
    const victims = [...this.indexes.values()].filter((index) => tableId === undefined || index.tableId === tableId);
    for (const index of victims) {
      this.indexes.delete(index.name);
      index.dead = true;
      index.connection?.interrupt();
    }
    await Promise.all(victims.map((index) => this.dropTable(index)));
  }

  get size(): number {
    return this.indexes.size;
  }

  private lookup(spec: BuildSpec): SortIndex {
    const existing = this.indexes.get(spec.name);
    if (existing) {
      // Refresh LRU position.
      this.indexes.delete(spec.name);
      this.indexes.set(spec.name, existing);
      return existing;
    }
    return this.startBuild(spec);
  }

  private wanted(index: SortIndex): boolean {
    // Requests with a view id do not count: once their view moved on they are stale.
    if (index.pinned || index.anonymous > 0) return true;
    for (const name of this.wants.values()) if (name === index.name) return true;
    return false;
  }

  private abandon(index: SortIndex): void {
    if (this.indexes.get(index.name) === index) this.indexes.delete(index.name);
    index.dead = true;
    index.connection?.interrupt();
  }

  private startBuild(spec: BuildSpec): SortIndex {
    const index: SortIndex = {
      name: spec.name,
      tableId: spec.tableId,
      connect: spec.connect,
      ready: Promise.resolve(),
      building: true,
      done: false,
      dead: false,
      connection: null,
      pinned: false,
      refs: 0,
      anonymous: 0,
    };
    index.ready = (async () => {
      const abandoned = () => new EngineFailure('superseded', 'Sort index no longer needed');
      // Read through a function: `dead` flips while this function awaits.
      const isDead = () => index.dead;
      try {
        // A failing `before` (e.g. "every row fits in the top-K block") abandons the build.
        if (spec.before) await spec.before();
        if (isDead()) throw abandoned();
        const connection = await spec.connect();
        index.connection = connection;
        try {
          // An interrupt may have been requested before the connection existed.
          if (isDead()) throw abandoned();
          await connection.run(`DROP TABLE IF EXISTS ${spec.name}`);
          await connection.run(spec.sql, spec.params.length > 0 ? spec.params : undefined);
          if (isDead()) {
            // Abandoned just as it finished: do not leak the table (unless a rebuild owns the name).
            if (!this.indexes.has(spec.name)) await connection.run(`DROP TABLE IF EXISTS ${spec.name}`);
            throw abandoned();
          }
          index.done = true;
        } finally {
          index.connection = null;
          connection.close();
        }
      } catch (error) {
        if (this.indexes.get(spec.name) === index) this.indexes.delete(spec.name);
        index.dead = true;
        if (error instanceof EngineFailure) throw error;
        if (isInterruptError(error)) throw new EngineFailure('superseded', 'Sort index build was interrupted');
        throw new EngineFailure('query_failed', `Sorting failed: ${errorMessage(error)}`, { cause: error });
      } finally {
        index.building = false;
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
    for (const index of victims) {
      this.indexes.delete(index.name);
      index.dead = true;
    }
    await Promise.all(victims.map((index) => this.dropTable(index)));
  }

  private async dropTable(index: SortIndex): Promise<void> {
    await index.ready.catch(() => undefined);
    // Rebuilt under the same name meanwhile: leave the new one alone.
    if (this.indexes.has(index.name)) return;
    try {
      const connection = await index.connect();
      try {
        if (!this.indexes.has(index.name)) await connection.run(`DROP TABLE IF EXISTS ${index.name}`);
      } finally {
        connection.close();
      }
    } catch (error) {
      // The table's instance may already be closed, which drops the table with it.
      if (!/closed|Connection/i.test(errorMessage(error))) {
        console.warn(`[engine] could not drop sort index ${index.name}: ${errorMessage(error)}`);
      }
    }
  }
}

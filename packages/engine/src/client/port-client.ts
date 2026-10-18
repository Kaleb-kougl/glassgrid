import { tableFromIPC, type Table } from 'apache-arrow';
import {
  AggregateSpecSchema,
  CrossfilterHintSchema,
  CubeTargetSchema,
  EngineResponseSchema,
  RequestFiltersSchema,
  type AggregateSpecInput,
  type CacheScope,
  type ColumnTypeOverride,
  type CrossfilterDimension,
  type CubeTarget,
  type EngineEvent,
  type EngineReply,
  type EngineRequest,
  type FileHandle,
  type FilterInput,
  type ParquetMode,
  type RowsQuery,
  type SortKey,
  type TableId,
} from '@glassgrid/core';
import type {
  AggregateResult,
  CacheStats,
  ColumnTypesResult,
  CountResult,
  CrossfilterQueryOptions,
  EngineClientApi,
  FetchPage,
  FilteredQueryOptions,
  OpenResult,
  PageOptions,
  ParquetCacheResult,
  PrepareCrossfilterResult,
  ProfileResult,
  QueryOptions,
  RowsResult,
} from './types';

/*
 * A transport-agnostic engine client: the desktop renderer's EngineClient
 * (apps/desktop/src/renderer/src/engine-client.ts) without Electron's
 * window/preload plumbing, over any MessagePort-like endpoint (a
 * MessagePort, a Worker, a Node MessagePort in tests). Same request
 * protocol, same per-view sequencing, superseding and page coalescing.
 */

/** What the client sends on and listens to: a MessagePort, a Worker, ... */
export interface EnginePort {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

function decode(reply: { ipc: Uint8Array }): Table {
  return tableFromIPC(reply.ipc);
}

export class EngineRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** For `bad_request` from the compiler: the offending input path, e.g. `y.aggregate`. */
    readonly path?: string,
  ) {
    super(message);
    this.name = 'EngineRequestError';
  }
}

type SafeParsed<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }> } };

/** Validate a request payload in the renderer, so mistakes fail before a round trip. */
function parseOrReject<T>(parsed: SafeParsed<T>, what: string): T {
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.map(String).join('.') ?? '';
    throw new EngineRequestError('bad_request', `Invalid ${what}${path ? ` at ${path}` : ''}: ${issue?.message ?? 'invalid'}`, path || undefined);
  }
  return parsed.data;
}

/** True for errors that only mean "a newer request replaced this one", "you cancelled it" or "the engine restarted" (views re-query). */
export function isAbandoned(error: unknown): boolean {
  return error instanceof EngineRequestError && (error.code === 'superseded' || error.code === 'cancelled' || error.code === 'engine_restarted');
}

interface SharedPage {
  promise: Promise<RowsResult>;
  controller: AbortController;
  waiters: number;
  table: TableId;
}

type ReplyOf<K extends EngineReply['kind']> = Extract<EngineReply, { kind: K }>;
type RequestBody = EngineRequest extends infer R ? (R extends EngineRequest ? Omit<R, 'requestId'> : never) : never;

interface Pending {
  resolve: (reply: EngineReply) => void;
  reject: (error: Error) => void;
  viewId: string | undefined;
  seq: number | undefined;
  /** Grid pages: never superseded by other requests of the view. */
  concurrent: boolean;
}

/**
 * Typed client for the engine over one port at a time.
 *
 * Ordering: requests that name a `viewId` get a per-view sequence number.
 * Sending a newer one rejects the older pending promise with `superseded`
 * right away, and any late response for it is dropped, so a view only ever
 * sees the result of its latest request.
 *
 * `adoptPort` may hand over a new port at any time (e.g. after the engine
 * restarted). In-flight requests on the old port are rejected with
 * `engine_restarted`; table ids stay valid because the engine reopens tables
 * on demand.
 */
export class PortEngineClient implements EngineClientApi {
  private port: EnginePort | null = null;
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly seqs = new Map<string, number>();
  private readonly waiters: Array<(port: EnginePort) => void> = [];
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private readonly restartListeners = new Set<() => void>();
  /** In-flight grid pages by (table, view, query, filters), shared by identical requests. */
  private readonly pages = new Map<string, SharedPage>();

  /**
   * @param onControl Messages on the port that are not engine responses (a
   *   worker's own control messages); return true when handled.
   */
  constructor(private readonly onControl: (message: unknown) => boolean = () => false) {}

  get connected(): boolean {
    return this.port !== null;
  }

  // -------------------------------------------------------------------------
  // QueryService

  async open(file: FileHandle, options: { parquet?: ParquetMode; signal?: AbortSignal } = {}): Promise<OpenResult> {
    const body = { kind: 'open' as const, file, ...(options.parquet ? { parquet: options.parquet } : {}) };
    const reply = await this.call(body, 'opened', options);
    return { table: reply.table, engineMs: reply.engineMs };
  }

  async profile(table: TableId, options: QueryOptions = {}): Promise<ProfileResult> {
    const reply = await this.call(this.viewScoped({ kind: 'profile', table }, options), 'profile', options);
    return { rowCount: reply.rowCount, columns: reply.columns, engineMs: reply.engineMs, cached: reply.cached };
  }

  async rows(table: TableId, query: RowsQuery, options: FilteredQueryOptions = {}): Promise<RowsResult> {
    const body = { kind: 'rows' as const, table, query, ...this.filters(options) };
    const reply = await this.call(this.viewScoped(body, options), 'arrow', options);
    return { table: decode(reply), engineMs: reply.engineMs, cached: reply.cached };
  }

  async count(table: TableId, options: FilteredQueryOptions & CrossfilterQueryOptions = {}): Promise<CountResult> {
    const body = { kind: 'count' as const, table, ...this.filters(options), ...this.crossfilter(options) };
    const reply = await this.call(this.viewScoped(body, options), 'count', options);
    return { rowCount: reply.rowCount, engineMs: reply.engineMs, cached: reply.cached, fromCube: reply.fromCube === true };
  }

  /**
   * One grid page for the canvas grid. Unlike `rows`, pages of the same view
   * run side by side (none supersedes another); the grid aborts the ones it
   * no longer needs through `signal`, which interrupts the engine query once
   * every caller of that page has aborted. Identical in-flight requests
   * (same table, view, offset, limit, sort and filters) share one round trip.
   * The engine caches pages by sort, filters and type overrides.
   */
  fetchPage(table: TableId, query: RowsQuery, options: PageOptions = {}): Promise<RowsResult> {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(new EngineRequestError('cancelled', 'Request was cancelled'));
    const viewId = options.viewId ?? 'grid';
    const filters = this.filters(options);
    const key = JSON.stringify([table, viewId, query.offset, query.limit, query.sort ?? [], filters.filters ?? []]);
    let shared = this.pages.get(key);
    if (!shared || shared.controller.signal.aborted) {
      const controller = new AbortController();
      const body = {
        kind: 'rows' as const,
        table,
        query,
        ...filters,
        viewId,
        // Concurrent pages do not advance the view's sequence; the engine skips ordering checks for them.
        seq: this.seqs.get(viewId) ?? 0,
        concurrent: true,
      };
      const created: SharedPage = {
        controller,
        waiters: 0,
        table,
        promise: this.call(body, 'arrow', { signal: controller.signal }).then((reply) => ({
          table: decode(reply),
          engineMs: reply.engineMs,
          cached: reply.cached,
        })),
      };
      created.promise
        .finally(() => {
          if (this.pages.get(key) === created) this.pages.delete(key);
        })
        .catch(() => undefined);
      this.pages.set(key, created);
      shared = created;
    }

    const current = shared;
    current.waiters += 1;
    return new Promise<RowsResult>((resolve, reject) => {
      let done = false;
      const finish = () => {
        if (done) return false;
        done = true;
        current.waiters -= 1;
        signal?.removeEventListener('abort', onAbort);
        return true;
      };
      const onAbort = () => {
        if (!finish()) return;
        reject(new EngineRequestError('cancelled', 'Request was cancelled'));
        if (current.waiters === 0) {
          if (this.pages.get(key) === current) this.pages.delete(key);
          current.controller.abort();
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      current.promise.then(
        (result) => {
          if (finish()) resolve(result);
        },
        (error: unknown) => {
          if (finish()) reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /**
   * A `fetchPage(offset, limit, signal)` bound to one view's table, sort and
   * filters: what the canvas grid holds per view. Make a new one when the
   * sort or filters change.
   */
  pageFetcher(table: TableId, view: { viewId?: string; sort?: SortKey[]; filters?: readonly FilterInput[] } = {}): FetchPage {
    return (offset, limit, signal) =>
      this.fetchPage(
        table,
        { offset, limit, ...(view.sort && view.sort.length > 0 ? { sort: view.sort } : {}) },
        {
          ...(view.viewId === undefined ? {} : { viewId: view.viewId }),
          ...(view.filters === undefined ? {} : { filters: view.filters }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
  }

  /**
   * Replace the table's column type overrides (the complete set; listing a
   * column with its inferred type, or leaving it out, clears its override).
   * The engine reads overridden columns with TRY_CAST, so values that do not
   * convert become NULL; `columns[].failedCasts` counts them. Cached pages,
   * counts, charts and sort indexes of the table are dropped, so views
   * should refetch afterwards. Re-send after `engine_restarted` (the engine
   * forgets overrides on restart; `table.typeOverrides` shows what it applies).
   */
  async setColumnTypes(
    table: TableId,
    overrides: readonly ColumnTypeOverride[],
    options: { signal?: AbortSignal } = {},
  ): Promise<ColumnTypesResult> {
    // Pages requested from now on must not join ones issued with the old types: neither those in flight
    // now, nor those requested while the engine applies the change (they may be read with either set).
    const forget = () => {
      for (const [key, page] of this.pages) if (page.table === table) this.pages.delete(key);
    };
    forget();
    try {
      const reply = await this.call({ kind: 'setColumnTypes', table, overrides: [...overrides] }, 'columnTypes', options);
      return { table: reply.table, columns: reply.columns, engineMs: reply.engineMs };
    } finally {
      forget();
    }
  }

  /**
   * Chart aggregate for a `ChartSpec` (plus the plot's `pixelWidth`). Use
   * `viewId: 'chart:<id>'` per chart card, so a newer request (e.g. while
   * brushing) supersedes the stale one.
   */
  async aggregate(table: TableId, spec: AggregateSpecInput, options: QueryOptions & CrossfilterQueryOptions = {}): Promise<AggregateResult> {
    const parsed = parseOrReject(AggregateSpecSchema.safeParse(spec), 'chart spec');
    const body = { kind: 'aggregate' as const, table, spec: parsed, ...this.crossfilter(options) };
    const reply = await this.call(this.viewScoped(body, options), 'aggregate', options);
    return {
      table: decode(reply),
      mark: reply.mark,
      fellBackToHeatmap: reply.fellBackToHeatmap,
      fromCube: reply.fromCube === true,
      engineMs: reply.engineMs,
      cached: reply.cached,
    };
  }

  /**
   * At brush start (pointer down): build the cubes the other views will need
   * (`crossfilterPlan(state, chartId)` gives the dimension and targets), so
   * the brush's commit is answered from them. Use one `viewId` for brushing
   * (default `brush`): a newer prepare supersedes this one. Builds already
   * running finish anyway and stay cached.
   */
  async prepareCrossfilter(
    table: TableId,
    plan: { dimension: CrossfilterDimension; targets: readonly CubeTarget[] },
    options: QueryOptions = {},
  ): Promise<PrepareCrossfilterResult> {
    const targets = plan.targets.map((target) => parseOrReject(CubeTargetSchema.safeParse(target), 'cross-filter target'));
    const scoped = { ...options, viewId: options.viewId ?? 'brush' };
    const body = { kind: 'prepareCrossfilter' as const, table, dimension: plan.dimension, targets };
    const reply = await this.call(this.viewScoped(body, scoped), 'crossfilterPrepared', scoped);
    return { cubes: reply.cubes, engineMs: reply.engineMs };
  }

  async ensureParquetCache(table: TableId): Promise<ParquetCacheResult> {
    const reply = await this.call({ kind: 'ensureParquetCache', table }, 'parquetCache');
    return { table: reply.table, alreadyCached: reply.alreadyCached, sizeBytes: reply.sizeBytes, engineMs: reply.engineMs };
  }

  /**
   * Done with a table (another file replaced it, or the window is closing).
   * The engine closes its DuckDB instance once no window holds it; the id
   * reopens on demand later (undo back to the file). In-flight grid pages of
   * the table are dropped from the coalescing map.
   */
  async closeTable(table: TableId): Promise<void> {
    for (const [key, page] of this.pages) if (page.table === table) this.pages.delete(key);
    await this.call({ kind: 'closeTable', table }, 'ack');
  }

  async clearCache(scope: CacheScope = 'all'): Promise<void> {
    await this.call({ kind: 'clearCache', scope }, 'ack');
  }

  async cacheStats(): Promise<CacheStats> {
    const reply = await this.call({ kind: 'cacheStats' }, 'cacheStats');
    return { results: reply.results, parquet: reply.parquet };
  }

  /**
   * Cancel a pending request by id (see `lastRequestId`); it rejects with
   * `cancelled` and the engine interrupts it. Passing `signal` in the
   * options does the same.
   */
  cancel(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending) return;
    this.pending.delete(requestId);
    pending.reject(new EngineRequestError('cancelled', 'Request was cancelled'));
    this.port?.postMessage({ kind: 'cancel', requestId: this.newId(), target: requestId } satisfies EngineRequest);
  }

  /** Id of the request most recently issued by any method (assigned synchronously on call). */
  get lastRequestId(): string {
    return `req-${this.nextId}`;
  }

  /**
   * Called when main hands over a new port after the engine restarted. The
   * engine reopens tables on demand with their inferred types, so callers
   * re-send type overrides and re-query their views. Returns an unsubscribe function.
   */
  onRestarted(listener: () => void): () => void {
    this.restartListeners.add(listener);
    return () => this.restartListeners.delete(listener);
  }

  /** Subscribe to engine events (Parquet progress, table updates). Returns an unsubscribe function. */
  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.port) this.port.onmessage = null;
    this.port = null;
    this.rejectAll(new EngineRequestError('disposed', 'Engine client disposed'));
  }

  // -------------------------------------------------------------------------

  private crossfilter(options: CrossfilterQueryOptions) {
    if (!options.crossfilter) return {};
    return { crossfilter: parseOrReject(CrossfilterHintSchema.safeParse(options.crossfilter), 'cross-filter hint') };
  }

  private filters(options: FilteredQueryOptions) {
    if (!options.filters || options.filters.length === 0) return {};
    return { filters: parseOrReject(RequestFiltersSchema.safeParse(options.filters), 'filters') };
  }

  private viewScoped<B extends { kind: 'profile' | 'rows' | 'count' | 'aggregate' | 'prepareCrossfilter' }>(body: B, options: QueryOptions) {
    // Requests without a view get a private one, so they never supersede anything.
    const viewId = options.viewId ?? `once-${this.nextId + 1}`;
    const seq = (this.seqs.get(viewId) ?? 0) + 1;
    if (options.viewId !== undefined) this.seqs.set(viewId, seq);
    return { ...body, viewId, seq };
  }

  private async call<K extends EngineReply['kind']>(
    body: RequestBody,
    expected: K,
    options: { signal?: AbortSignal } = {},
  ): Promise<ReplyOf<K>> {
    options.signal?.throwIfAborted();
    const requestId = this.newId();
    const request: EngineRequest = { ...body, requestId };
    const viewId = 'viewId' in request ? request.viewId : undefined;
    const seq = 'seq' in request ? request.seq : undefined;
    const concurrent = request.kind === 'rows' && request.concurrent === true;

    // A newer request for the view makes older pending ones irrelevant (grid pages excepted).
    if (viewId !== undefined && !concurrent) {
      for (const [id, pending] of this.pending) {
        if (pending.viewId === viewId && !pending.concurrent) {
          this.pending.delete(id);
          pending.reject(new EngineRequestError('superseded', 'Superseded by a newer request for the same view'));
        }
      }
    }

    const onAbort = () => this.cancel(requestId);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const settled = new Promise<EngineReply>((resolve, reject) => {
      // Registered before the port exists, so superseding works even while connecting.
      this.pending.set(requestId, { resolve, reject, viewId, seq, concurrent });
    });
    void this.connectedPort().then((port) => {
      if (!this.pending.has(requestId)) return;
      port.postMessage(request);
    });
    let reply: EngineReply;
    try {
      reply = await settled;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
    if (reply.kind !== expected) {
      throw new EngineRequestError('bad_response', `Expected a "${expected}" reply, got "${reply.kind}"`);
    }
    return reply as ReplyOf<K>;
  }

  /** Start talking to the engine over `port`; a second call is an engine restart. */
  adoptPort(port: EnginePort): void {
    const restarted = this.port !== null;
    if (this.port) {
      this.port.onmessage = null;
      this.pages.clear();
      this.rejectAll(new EngineRequestError('engine_restarted', 'The engine restarted; please retry'));
    }
    this.port = port;
    port.onmessage = (event: MessageEvent) => this.onResponse(event.data);
    for (const waiter of this.waiters.splice(0)) waiter(port);
    if (restarted) for (const listener of [...this.restartListeners]) listener();
  }

  /** Reject everything in flight (the engine went away) until `adoptPort` is called again. */
  disconnect(error: Error): void {
    if (this.port) this.port.onmessage = null;
    this.port = null;
    this.pages.clear();
    this.rejectAll(error);
  }

  private connectedPort(): Promise<EnginePort> {
    if (this.port) return Promise.resolve(this.port);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private onResponse(raw: unknown): void {
    if (this.onControl(raw)) return;
    const parsed = EngineResponseSchema.safeParse(raw);
    if (!parsed.success) {
      console.error('[engine-client] dropped malformed response', parsed.error.issues);
      return;
    }
    const response = parsed.data;
    if (response.kind === 'event') {
      for (const listener of this.listeners) listener(response.event);
      return;
    }
    if (response.requestId === null) {
      console.error('[engine-client] engine rejected an unidentifiable request', response);
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) return; // superseded, cancelled or already settled
    this.pending.delete(response.requestId);
    // Belt and braces: never deliver a response older than the view's latest request.
    if (
      !pending.concurrent &&
      pending.viewId !== undefined &&
      this.seqs.has(pending.viewId) &&
      this.seqs.get(pending.viewId) !== pending.seq
    ) {
      pending.reject(new EngineRequestError('superseded', 'Superseded by a newer request for the same view'));
      return;
    }

    if (response.kind === 'error') {
      pending.reject(new EngineRequestError(response.code, response.message, response.path));
      return;
    }
    pending.resolve(response);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private newId(): string {
    this.nextId += 1;
    return `req-${this.nextId}`;
  }
}

import { tableFromIPC, type Table } from 'apache-arrow';
import {
  ENGINE_PORT_WINDOW_MESSAGE,
  EngineResponseSchema,
  type CacheScope,
  type TableColumnProfile,
  type EngineEvent,
  type EngineReply,
  type EngineRequest,
  type FileHandle,
  type GlassgridBridge,
  type ParquetCacheStats,
  type ParquetMode,
  type ResultCacheStats,
  type RowsQuery,
  type TableHandle,
  type TableId,
} from '@glassgrid/core';

export class EngineRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EngineRequestError';
  }
}

/** True for errors that only mean "a newer request replaced this one" or "you cancelled it". */
export function isAbandoned(error: unknown): boolean {
  return error instanceof EngineRequestError && (error.code === 'superseded' || error.code === 'cancelled');
}

export interface QueryOptions {
  /**
   * Logical consumer of the result (e.g. `grid`, `chart:3`). A newer request
   * for the same view rejects older pending ones with `superseded`, and the
   * engine interrupts them. Omit for one-off requests that must not replace
   * anything.
   */
  viewId?: string;
  /** Aborting sends `cancel` and rejects with `cancelled`. */
  signal?: AbortSignal;
}

interface Timed {
  /** Time spent inside the engine, as reported by the engine. */
  engineMs: number;
  /** Served from the engine's result cache. */
  cached: boolean;
}

export interface RowsResult extends Timed {
  table: Table;
}

export interface CountResult extends Timed {
  rowCount: number;
}

export interface ProfileResult extends Timed {
  rowCount: number;
  columns: TableColumnProfile[];
}

export interface OpenResult {
  table: TableHandle;
  engineMs: number;
}

export interface ParquetCacheResult {
  table: TableHandle;
  alreadyCached: boolean;
  sizeBytes: number;
  engineMs: number;
}

export interface CacheStats {
  results: ResultCacheStats;
  parquet: ParquetCacheStats;
}

type ReplyOf<K extends EngineReply['kind']> = Extract<EngineReply, { kind: K }>;
type RequestBody = EngineRequest extends infer R ? (R extends EngineRequest ? Omit<R, 'requestId'> : never) : never;

interface Pending {
  resolve: (reply: EngineReply) => void;
  reject: (error: Error) => void;
  viewId: string | undefined;
  seq: number | undefined;
}

/**
 * Typed client for the engine, over a MessagePort that main brokers directly
 * between renderer and engine; this traffic never passes through main.
 *
 * Ordering: requests that name a `viewId` get a per-view sequence number.
 * Sending a newer one rejects the older pending promise with `superseded`
 * right away, and any late response for it is dropped, so a view only ever
 * sees the result of its latest request.
 *
 * Main may hand over a new port at any time (e.g. after an engine restart).
 * In-flight requests on the old port are rejected with `engine_restarted`;
 * table ids stay valid because the engine reopens tables on demand.
 */
export class EngineClient {
  private port: MessagePort | null = null;
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly seqs = new Map<string, number>();
  private readonly waiters: Array<(port: MessagePort) => void> = [];
  private readonly listeners = new Set<(event: EngineEvent) => void>();

  constructor(private readonly bridge: GlassgridBridge) {
    window.addEventListener('message', this.onWindowMessage);
    this.bridge.requestEnginePort();
  }

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

  async rows(table: TableId, query: RowsQuery, options: QueryOptions = {}): Promise<RowsResult> {
    const reply = await this.call(this.viewScoped({ kind: 'rows', table, query }, options), 'arrow', options);
    return { table: tableFromIPC(reply.ipc), engineMs: reply.engineMs, cached: reply.cached };
  }

  async count(table: TableId, options: QueryOptions = {}): Promise<CountResult> {
    const reply = await this.call(this.viewScoped({ kind: 'count', table }, options), 'count', options);
    return { rowCount: reply.rowCount, engineMs: reply.engineMs, cached: reply.cached };
  }

  /** Chart aggregate; the engine answers `not_implemented` until the spec compiler lands. */
  async aggregate(table: TableId, spec: unknown, options: QueryOptions = {}): Promise<RowsResult> {
    const reply = await this.call(this.viewScoped({ kind: 'aggregate', table, spec }, options), 'arrow', options);
    return { table: tableFromIPC(reply.ipc), engineMs: reply.engineMs, cached: reply.cached };
  }

  async ensureParquetCache(table: TableId): Promise<ParquetCacheResult> {
    const reply = await this.call({ kind: 'ensureParquetCache', table }, 'parquetCache');
    return { table: reply.table, alreadyCached: reply.alreadyCached, sizeBytes: reply.sizeBytes, engineMs: reply.engineMs };
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

  /** Subscribe to engine events (Parquet progress, table updates). Returns an unsubscribe function. */
  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    window.removeEventListener('message', this.onWindowMessage);
    this.port?.close();
    this.port = null;
    this.rejectAll(new EngineRequestError('disposed', 'Engine client disposed'));
  }

  // -------------------------------------------------------------------------

  private viewScoped<B extends { kind: 'profile' | 'rows' | 'count' | 'aggregate' }>(body: B, options: QueryOptions) {
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

    // A newer request for the view makes older pending ones irrelevant.
    if (viewId !== undefined) {
      for (const [id, pending] of this.pending) {
        if (pending.viewId === viewId) {
          this.pending.delete(id);
          pending.reject(new EngineRequestError('superseded', 'Superseded by a newer request for the same view'));
        }
      }
    }

    const onAbort = () => this.cancel(requestId);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const settled = new Promise<EngineReply>((resolve, reject) => {
      // Registered before the port exists, so superseding works even while connecting.
      this.pending.set(requestId, { resolve, reject, viewId, seq });
    });
    void this.connectedPort().then((port) => {
      if (this.pending.has(requestId)) port.postMessage(request);
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

  private readonly onWindowMessage = (event: MessageEvent): void => {
    // Only accept the port the preload posted to this very window.
    if (event.source !== window || event.data !== ENGINE_PORT_WINDOW_MESSAGE) return;
    const [port] = event.ports;
    if (port) this.adoptPort(port);
  };

  private adoptPort(port: MessagePort): void {
    if (this.port) {
      this.port.close();
      this.rejectAll(new EngineRequestError('engine_restarted', 'The engine restarted; please retry'));
    }
    this.port = port;
    port.onmessage = (event: MessageEvent) => this.onResponse(event.data);
    for (const waiter of this.waiters.splice(0)) waiter(port);
  }

  private connectedPort(): Promise<MessagePort> {
    if (this.port) return Promise.resolve(this.port);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private onResponse(raw: unknown): void {
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
    if (pending.viewId !== undefined && this.seqs.has(pending.viewId) && this.seqs.get(pending.viewId) !== pending.seq) {
      pending.reject(new EngineRequestError('superseded', 'Superseded by a newer request for the same view'));
      return;
    }

    if (response.kind === 'error') {
      pending.reject(new EngineRequestError(response.code, response.message));
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

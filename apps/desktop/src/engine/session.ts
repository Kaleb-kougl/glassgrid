import {
  EngineRequestSchema,
  compileChartQuery,
  compileScatterCountQuery,
  compileWhere,
  isCompileError,
  isViewScopedRequest,
  quoteIdent,
  scatterAsHeatmap,
  scatterPointLimit,
  tableIdForFile,
  type AggregateSpec,
  type ChartSpec,
  type CompiledQuery,
  type EngineEvent,
  type EngineReply,
  type EngineRequest,
  type EngineResponse,
  type Filter,
  type TableId,
} from '@glassgrid/core';
import { EngineFailure, abortCode, errorMessage, toEngineFailure } from './errors';
import { QueryService, type Cached, type RequestContext } from './query-service';
import type { SqlFragment, SqlParam } from './sql-text';

interface InFlight {
  controller: AbortController;
  viewId: string | undefined;
  /** A concurrent grid page: never supersedes, never superseded. */
  concurrent: boolean;
}

/** The compiler's output as an engine SQL fragment (its params are always JSON scalars). */
export function toFragment(compiled: CompiledQuery): SqlFragment {
  const params = compiled.params.map((value): SqlParam => {
    if (value === null || ['string', 'number', 'boolean', 'bigint'].includes(typeof value)) return value as SqlParam;
    throw new EngineFailure('query_failed', `Unsupported bound value of type ${typeof value}`);
  });
  return { sql: compiled.sql, params };
}

/**
 * Compile request filters to a WHERE fragment over the table's columns, or
 * undefined when there are none (so unfiltered pages keep their fast path).
 * `compileWhere` numbers its placeholders `$1..$n`; the engine writes its own
 * offsets and limits as literals, so the fragment is the only placeholder
 * source in the final statement.
 */
async function compileFilters(
  service: QueryService,
  table: TableId,
  filters: readonly Filter[] | undefined,
  ctx: RequestContext,
): Promise<SqlFragment | undefined> {
  if (!filters || filters.length === 0) return undefined;
  return toFragment(compileWhere(filters, await service.columns(table, ctx)));
}

export interface AggregateOutcome extends Cached<Uint8Array> {
  /** The mark the rows are shaped for (`heatmap` after a scatter fallback). */
  mark: ChartSpec['mark'];
  fellBackToHeatmap: boolean;
}

/**
 * Compile and run a chart aggregate against the table's cached profile.
 * Scatter specs are counted first: above `scatterPointLimit(spec)` points the
 * engine answers with `scatterAsHeatmap(spec)` instead (see docs/m1-compiler.md).
 */
export async function runAggregate(
  service: QueryService,
  table: TableId,
  request: AggregateSpec,
  ctx: RequestContext,
): Promise<AggregateOutcome> {
  const { pixelWidth, ...spec } = request;
  // Profiles are cached per table, so only the first chart pays for the scan.
  const columns = (await service.profile(table, ctx)).value.columns;
  const relation = quoteIdent(QueryService.viewName(table));

  let chart: ChartSpec = spec;
  let fellBackToHeatmap = false;
  if (spec.mark === 'scatter') {
    const points = await service.countQuery(table, toFragment(compileScatterCountQuery(relation, spec, columns)), ctx);
    if (points.value > scatterPointLimit(spec)) {
      chart = scatterAsHeatmap(spec);
      fellBackToHeatmap = true;
    }
  }
  const compiled = compileChartQuery(relation, chart, columns, pixelWidth === undefined ? {} : { pixelWidth });
  const result = await service.aggregate(table, toFragment(compiled), { pixelWidth }, ctx);
  return { ...result, mark: chart.mark, fellBackToHeatmap };
}

/**
 * One renderer connection (MessagePort) to the engine: validates requests,
 * runs them on the shared QueryService and enforces ordering per view.
 *
 * - Each view-scoped request carries `(viewId, seq)`. A request with a
 *   higher seq interrupts every in-flight request of the same view; their
 *   responses are dropped. A request whose seq is not newer than one already
 *   seen is answered `superseded` without running.
 * - `rows` with `concurrent: true` (grid pages) opts out of both: pages of
 *   one view run side by side and the grid cancels the ones it no longer
 *   needs. Identical in-flight pages share one query (QueryService).
 * - `cancel` interrupts the target and answers it `cancelled` at once; a
 *   late result for it is dropped.
 * - Every failure becomes an `error` reply with a code; nothing a renderer
 *   sends can throw out of `handle()`.
 */
let nextSessionId = 0;

export class EngineSession {
  /** Scopes view ids in the shared QueryService, so two windows' `grid` views stay independent. */
  private readonly id = `s${(nextSessionId += 1)}`;
  private readonly inflight = new Map<string, InFlight>();
  private readonly latestSeq = new Map<string, number>();
  /** Tables this connection has used (see QueryService.retainTable). */
  private readonly tables = new Set<TableId>();
  private readonly onEvent = (event: EngineEvent) => this.send({ kind: 'event', event });
  private disposed = false;

  constructor(
    private readonly service: Promise<QueryService>,
    private readonly send: (message: EngineResponse) => void,
  ) {
    service.then(
      (ready) => {
        if (!this.disposed) ready.on('event', this.onEvent);
      },
      () => undefined,
    );
  }

  handle(raw: unknown): void {
    if (this.disposed) return;
    const parsed = EngineRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const requestId =
        typeof raw === 'object' && raw !== null && 'requestId' in raw && typeof raw.requestId === 'string'
          ? raw.requestId.slice(0, 128) || null
          : null;
      this.send({ kind: 'error', requestId, code: 'bad_request', message: parsed.error.message });
      return;
    }
    const request = parsed.data;

    if (request.kind === 'cancel') {
      this.abort(request.target, new EngineFailure('cancelled', 'Request was cancelled'));
      return;
    }
    if (this.inflight.has(request.requestId)) {
      this.send({ kind: 'error', requestId: request.requestId, code: 'bad_request', message: 'Duplicate request id' });
      return;
    }

    let viewId: string | undefined;
    const concurrent = request.kind === 'rows' && request.concurrent === true;
    if (isViewScopedRequest(request) && concurrent) {
      viewId = request.viewId;
    } else if (isViewScopedRequest(request)) {
      viewId = request.viewId;
      const latest = this.latestSeq.get(viewId);
      if (latest !== undefined && request.seq <= latest) {
        this.send({
          kind: 'error',
          requestId: request.requestId,
          code: 'superseded',
          message: `A newer request (seq ${latest}) exists for view "${viewId}"`,
        });
        return;
      }
      this.latestSeq.set(viewId, request.seq);
      for (const [requestId, flight] of this.inflight) {
        if (flight.viewId === viewId && !flight.concurrent) {
          this.abort(requestId, new EngineFailure('superseded', 'Superseded by a newer request for the same view'));
        }
      }
    }

    // Tables this connection uses stay open until it closes them or disconnects.
    const used = request.kind === 'open' ? tableIdForFile(request.file) : 'table' in request ? request.table : null;
    if (used !== null && !this.tables.has(used)) {
      this.tables.add(used);
      void this.service.then((ready) => ready.retainTable(used, this.id), () => undefined);
    }

    const controller = new AbortController();
    this.inflight.set(request.requestId, { controller, viewId, concurrent });
    const ctx = { signal: controller.signal, ...(viewId === undefined ? {} : { viewId: `${this.id}:${viewId}` }) };
    void this.run(request, ctx).then((reply) => {
      // Superseded or cancelled requests were already answered (or are dropped).
      if (this.inflight.get(request.requestId)?.controller !== controller) return;
      this.inflight.delete(request.requestId);
      if (!this.disposed) this.send(reply);
    });
  }

  /** Abort everything; called when the port closes. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const flight of this.inflight.values()) {
      flight.controller.abort(new EngineFailure('cancelled', 'Connection closed'));
    }
    this.inflight.clear();
    void this.service.then(
      (ready) => {
        ready.off('event', this.onEvent);
        ready.releaseViews(`${this.id}:`);
        void ready.releaseHolder(this.id).catch(() => undefined);
      },
      () => undefined,
    );
  }

  private abort(requestId: string, reason: EngineFailure): void {
    const flight = this.inflight.get(requestId);
    if (!flight) return;
    this.inflight.delete(requestId);
    flight.controller.abort(reason);
    // Stale results are dropped silently; explicit cancels get an answer.
    if (reason.code === 'cancelled') {
      this.send({ kind: 'error', requestId, code: 'cancelled', message: reason.message });
    }
  }

  private async run(request: Exclude<EngineRequest, { kind: 'cancel' }>, ctx: RequestContext): Promise<EngineReply> {
    const started = performance.now();
    const elapsed = () => performance.now() - started;
    const { requestId } = request;
    try {
      let service: QueryService;
      try {
        service = await this.service;
      } catch (error) {
        throw new EngineFailure('engine_unavailable', `DuckDB failed to start: ${errorMessage(error)}`);
      }

      switch (request.kind) {
        case 'open': {
          const table = await service.open(
            request.file,
            request.parquet === undefined ? {} : { parquet: request.parquet },
            ctx,
          );
          return { kind: 'opened', requestId, table, engineMs: elapsed() };
        }
        case 'profile': {
          const { value, cached } = await service.profile(request.table, ctx);
          return { kind: 'profile', requestId, ...value, cached, engineMs: elapsed() };
        }
        case 'rows': {
          const where = await compileFilters(service, request.table, request.filters, ctx);
          const query = where ? { ...request.query, where } : request.query;
          const { value, cached } = await service.rows(request.table, query, ctx);
          return { kind: 'arrow', requestId, ipc: value, cached, engineMs: elapsed() };
        }
        case 'count': {
          const where = await compileFilters(service, request.table, request.filters, ctx);
          const { value, cached } = await service.count(request.table, where, ctx);
          return { kind: 'count', requestId, rowCount: value, cached, engineMs: elapsed() };
        }
        case 'aggregate': {
          const outcome = await runAggregate(service, request.table, request.spec, ctx);
          return {
            kind: 'aggregate',
            requestId,
            ipc: outcome.value,
            mark: outcome.mark,
            fellBackToHeatmap: outcome.fellBackToHeatmap,
            cached: outcome.cached,
            engineMs: elapsed(),
          };
        }
        case 'ensureParquetCache': {
          const outcome = await service.ensureParquetCache(request.table);
          return { kind: 'parquetCache', requestId, ...outcome, engineMs: elapsed() };
        }
        case 'clearCache':
          await service.clearCache(request.scope ?? 'all');
          return { kind: 'ack', requestId };
        case 'setColumnTypes': {
          const outcome = await service.setColumnTypes(request.table, request.overrides, ctx);
          return { kind: 'columnTypes', requestId, table: outcome.table, columns: outcome.columns, engineMs: elapsed() };
        }
        case 'closeTable':
          // Retained above as this request names the table; releasing drops this connection's hold.
          this.tables.delete(request.table);
          await service.releaseTable(request.table, this.id);
          return { kind: 'ack', requestId };
        case 'cacheStats':
          return {
            kind: 'cacheStats',
            requestId,
            results: service.resultCacheStats(),
            parquet: await service.parquetCacheStats(),
          };
      }
    } catch (error) {
      if (isCompileError(error) && !ctx.signal?.aborted) {
        // Spec problems are the caller's to fix; the message names the path and valid options.
        return {
          kind: 'error',
          requestId,
          code: 'bad_request',
          message: error.message,
          ...(error.path === undefined ? {} : { path: error.path }),
        };
      }
      const failure = toEngineFailure(error, ctx.signal);
      const code = ctx.signal?.aborted ? abortCode(ctx.signal) : failure.code;
      return { kind: 'error', requestId, code, message: failure.message };
    }
  }
}

import {
  EngineRequestSchema,
  compileChartCubeAnswer,
  compileChartCubeBuild,
  compileChartQuery,
  compileCountCubeAnswer,
  compileCountCubeBuild,
  compileScatterCountQuery,
  compileWhere,
  cubeSelection,
  estimateCubeCells,
  dimensionCardinality,
  isCompileError,
  isViewScopedRequest,
  quoteIdent,
  scatterAsHeatmap,
  scatterPointLimit,
  tableIdForFile,
  type AggregateSpec,
  type ChartSpec,
  type CompiledQuery,
  type CrossfilterDimension,
  type CrossfilterHint,
  type CubeTarget,
  type EngineEvent,
  type EngineReply,
  type EngineRequest,
  type EngineResponse,
  type Filter,
  type PreparedCube,
  type TableColumnProfile,
  type TableId,
} from '@glassgrid/core';
import { MAX_CUBE_ESTIMATE } from './cubes';
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
  /** Answered from a cross-filter cube. */
  fromCube: boolean;
}

/** Why a request with a cross-filter hint cannot use a cube, or the parts to build and answer it. */
type CubePlan =
  | { ok: true; base: Filter[]; selection: Filter | null }
  | { ok: false; reason: string };

/**
 * Split `filters` into the cube's base filters and the brushed selection
 * (`hint.filter`), and check that a cube over `dimension` can answer it
 * exactly. With no hint index (prepare), every filter is a base filter.
 */
function planCube(
  filters: readonly Filter[],
  hintIndex: number | null,
  dimension: CrossfilterDimension,
  columns: readonly TableColumnProfile[],
): CubePlan {
  const column = columns.find((candidate) => candidate.name === dimension.column);
  if (!column) return { ok: false, reason: `unknown column ${JSON.stringify(dimension.column)}` };
  if (hintIndex === null) return { ok: true, base: [...filters], selection: null };
  const selection = filters[hintIndex];
  if (selection === undefined) return { ok: false, reason: 'the hint names no filter' };
  if (cubeSelection(selection, dimension) === null) return { ok: false, reason: 'the selection is not aligned to the dimension' };
  return { ok: true, base: filters.filter((_, i) => i !== hintIndex), selection };
}

/** Cube sizes the profile can rule out before a build. */
function estimateTooLarge(estimate: number | null): string | null {
  return estimate !== null && estimate > MAX_CUBE_ESTIMATE ? `about ${estimate} cells` : null;
}

/**
 * A chart from its cross-filter cube, or null when no cube applies (the
 * caller then runs the plain query). Building the cube is the expensive part
 * and happens once per (chart, other filters, dimension).
 */
async function cubeAggregate(
  service: QueryService,
  table: TableId,
  request: AggregateSpec,
  hint: { index: number | null; dimension: CrossfilterDimension },
  ctx: RequestContext,
): Promise<{ outcome: Cached<Uint8Array> | null; skipped: string | null; rows: number }> {
  const { pixelWidth, ...spec } = request;
  if (spec.mark === 'scatter') return { outcome: null, skipped: 'scatter plots raw points', rows: 0 };
  const columns = (await service.profile(table, ctx)).value.columns;
  const plan = planCube(spec.filters, hint.index, hint.dimension, columns);
  if (!plan.ok) return { outcome: null, skipped: plan.reason, rows: 0 };
  const baseSpec: ChartSpec = { ...spec, filters: plan.base };
  const tooLarge = estimateTooLarge(estimateCubeCells(baseSpec, columns, hint.dimension));
  if (tooLarge) return { outcome: null, skipped: tooLarge, rows: 0 };
  const relation = quoteIdent(QueryService.viewName(table));
  const opts = pixelWidth === undefined ? {} : { pixelWidth };
  const cube = await service.cube(table, toFragment(compileChartCubeBuild(relation, baseSpec, columns, hint.dimension, opts)), ctx);
  if (cube === null) return { outcome: null, skipped: 'the cube has too many cells', rows: 0 };
  if (hint.index === null) return { outcome: null, skipped: null, rows: cube.rows };
  const answer = compileChartCubeAnswer(cube.name, baseSpec, columns, hint.dimension, plan.selection, opts);
  return { outcome: await service.cubeAggregate(table, cube, toFragment(answer), { pixelWidth }, ctx), skipped: null, rows: cube.rows };
}

/** A row count from its cross-filter cube, or null when no cube applies. */
async function cubeCount(
  service: QueryService,
  table: TableId,
  filters: readonly Filter[],
  hint: { index: number | null; dimension: CrossfilterDimension },
  ctx: RequestContext,
): Promise<{ outcome: Cached<number> | null; skipped: string | null; rows: number }> {
  const columns = (await service.profile(table, ctx)).value.columns;
  const plan = planCube(filters, hint.index, hint.dimension, columns);
  if (!plan.ok) return { outcome: null, skipped: plan.reason, rows: 0 };
  const tooLarge = estimateTooLarge(dimensionCardinality(columns, hint.dimension));
  if (tooLarge) return { outcome: null, skipped: tooLarge, rows: 0 };
  const relation = quoteIdent(QueryService.viewName(table));
  const cube = await service.cube(table, toFragment(compileCountCubeBuild(relation, plan.base, columns, hint.dimension)), ctx);
  if (cube === null) return { outcome: null, skipped: 'the cube has too many cells', rows: 0 };
  if (hint.index === null) return { outcome: null, skipped: null, rows: cube.rows };
  const answer = compileCountCubeAnswer(cube.name, columns, hint.dimension, plan.selection);
  return { outcome: await service.cubeCount(table, cube, toFragment(answer), ctx), skipped: null, rows: cube.rows };
}

/**
 * Runs `attempt` (a cube answer) and falls back to null on any failure that
 * is not the caller's cancellation, e.g. a cube evicted between its build and
 * the answer, or a compile error the plain query will report properly.
 */
async function orPlain<T>(attempt: () => Promise<T | null>, ctx: RequestContext): Promise<T | null> {
  try {
    return await attempt();
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    return null;
  }
}

/**
 * Compile and run a chart aggregate against the table's cached profile.
 * Scatter specs are counted first: above `scatterPointLimit(spec)` points the
 * engine answers with `scatterAsHeatmap(spec)` instead (see docs/m1-compiler.md).
 * With a cross-filter hint the chart is answered from its cube when one
 * applies (see `cubeAggregate`).
 */
export async function runAggregate(
  service: QueryService,
  table: TableId,
  request: AggregateSpec,
  ctx: RequestContext,
  crossfilter?: CrossfilterHint,
): Promise<AggregateOutcome> {
  if (crossfilter) {
    const fromCube = await orPlain(
      async () => (await cubeAggregate(service, table, request, { index: crossfilter.filter, dimension: crossfilter.dimension }, ctx)).outcome,
      ctx,
    );
    if (fromCube) return { ...fromCube, mark: request.mark, fellBackToHeatmap: false, fromCube: true };
  }
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
  return { ...result, mark: chart.mark, fellBackToHeatmap, fromCube: false };
}

/** A filtered row count, from a cross-filter cube when the hint allows one. */
export async function runCount(
  service: QueryService,
  table: TableId,
  filters: readonly Filter[] | undefined,
  ctx: RequestContext,
  crossfilter?: CrossfilterHint,
): Promise<Cached<number> & { fromCube: boolean }> {
  if (crossfilter && filters) {
    const fromCube = await orPlain(
      async () => (await cubeCount(service, table, filters, { index: crossfilter.filter, dimension: crossfilter.dimension }, ctx)).outcome,
      ctx,
    );
    if (fromCube) return { ...fromCube, fromCube: true };
  }
  const where = await compileFilters(service, table, filters, ctx);
  return { ...(await service.count(table, where, ctx)), fromCube: false };
}

/** Builds (or finds) the cubes a brush on `dimension` will need; one entry per target, in order. */
export async function prepareCrossfilter(
  service: QueryService,
  table: TableId,
  dimension: CrossfilterDimension,
  targets: readonly CubeTarget[],
  ctx: RequestContext,
): Promise<PreparedCube[]> {
  return Promise.all(
    targets.map(async (target): Promise<PreparedCube> => {
      try {
        const outcome =
          target.kind === 'aggregate'
            ? await cubeAggregate(service, table, target.spec, { index: null, dimension }, ctx)
            : await cubeCount(service, table, target.filters, { index: null, dimension }, ctx);
        return outcome.skipped === null ? { status: 'ready', rows: outcome.rows } : { status: 'skipped', reason: outcome.skipped };
      } catch (error) {
        if (ctx.signal?.aborted) throw error;
        return { status: 'skipped', reason: errorMessage(error) };
      }
    }),
  );
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
          const { value, cached, fromCube } = await runCount(service, request.table, request.filters, ctx, request.crossfilter);
          return { kind: 'count', requestId, rowCount: value, cached, fromCube, engineMs: elapsed() };
        }
        case 'aggregate': {
          const outcome = await runAggregate(service, request.table, request.spec, ctx, request.crossfilter);
          return {
            kind: 'aggregate',
            requestId,
            ipc: outcome.value,
            mark: outcome.mark,
            fellBackToHeatmap: outcome.fellBackToHeatmap,
            fromCube: outcome.fromCube,
            cached: outcome.cached,
            engineMs: elapsed(),
          };
        }
        case 'prepareCrossfilter': {
          const cubes = await prepareCrossfilter(service, request.table, request.dimension, request.targets, ctx);
          return { kind: 'crossfilterPrepared', requestId, cubes, engineMs: elapsed() };
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

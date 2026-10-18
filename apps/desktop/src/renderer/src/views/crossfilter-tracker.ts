import { CROSSFILTER_MEASURE, type CrossfilterMeasureDetail, type CrossfilterViewTiming } from '../perf';

/*
 * Times one cross-filter update for the M3 budget: from the moment a brush
 * is released (or a bar clicked) to the last other view painted with the new
 * filters. Views are named `chart:<id>`, `grid:count` and `grid:rows`; each
 * carries the key of the query it shows (the core's `viewQueries` key, or
 * the grid's filters), so a paint of a stale result does not count.
 */

export interface PaintInfo {
  readonly engineMs: number;
  readonly fromCube: boolean;
  readonly cached: boolean;
}

interface Pending {
  readonly start: string;
  readonly startedAt: number;
  readonly source: string;
  /** View keys before the commit. */
  readonly before: ReadonlyMap<string, string>;
  /** Views still to paint, with the key they must paint; null until armed. */
  waiting: Map<string, string> | null;
  readonly views: CrossfilterViewTiming[];
  filters: unknown[];
  rowCount: number | null;
}

/** Gives up on an update whose views never all paint (e.g. a query failed). */
const STALE_MS = 60_000;

export class CrossfilterTracker {
  private pending: Pending | null = null;
  private seq = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** A brush was released on `source`; `before` are the views' keys at that moment. */
  begin(source: string, before: ReadonlyMap<string, string>): void {
    this.cancel();
    this.seq += 1;
    const start = `${CROSSFILTER_MEASURE}:start:${this.seq}`;
    performance.mark(start);
    this.pending = { start, startedAt: this.now(), source, before, waiting: null, views: [], filters: [], rowCount: null };
  }

  /**
   * The commit was applied: `after` are the views' keys now. Every view whose
   * key changed must paint before the update counts as done. Nothing changed
   * (the snapped brush equals the previous one): the update is dropped.
   */
  arm(after: ReadonlyMap<string, string>, filters: unknown[]): void {
    const pending = this.pending;
    if (!pending || pending.waiting) return;
    const waiting = new Map<string, string>();
    for (const [view, key] of after) if (pending.before.get(view) !== key) waiting.set(view, key);
    if (waiting.size === 0) {
      this.cancel();
      return;
    }
    pending.waiting = waiting;
    pending.filters = filters;
  }

  /** Whether an update is waiting for its views. */
  get active(): boolean {
    return this.pending !== null;
  }

  /** `view` painted the result of the query with `key`. */
  painted(view: string, key: string, info: PaintInfo, rowCount?: number): void {
    const pending = this.pending;
    if (!pending?.waiting) return;
    if (this.now() - pending.startedAt > STALE_MS) {
      this.cancel();
      return;
    }
    if (pending.waiting.get(view) !== key) return;
    pending.waiting.delete(view);
    pending.views.push({ view, ms: this.now() - pending.startedAt, ...info });
    if (rowCount !== undefined) pending.rowCount = rowCount;
    if (pending.waiting.size > 0) return;
    this.pending = null;
    const end = `${CROSSFILTER_MEASURE}:end:${this.seq}`;
    performance.mark(end);
    const detail: CrossfilterMeasureDetail = { source: pending.source, filters: pending.filters, rowCount: pending.rowCount, views: pending.views };
    performance.measure(CROSSFILTER_MEASURE, { start: pending.start, end, detail });
    performance.clearMarks(pending.start);
    performance.clearMarks(end);
  }

  cancel(): void {
    if (this.pending) performance.clearMarks(this.pending.start);
    this.pending = null;
  }
}

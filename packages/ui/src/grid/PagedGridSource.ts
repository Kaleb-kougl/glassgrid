import { PAGE_SIZE } from './geometry.js';
import type { GridCell, GridColumn, GridDataSource, GridSourceChange, GridSourceListener } from './types.js';

/** One loaded page: display values column by column (source column order). */
export type PageColumns = readonly (readonly GridCell[])[];

export interface PagedSourceOptions {
  readonly columns: readonly GridColumn[];
  readonly rowCount: number;
  /** Rows per page (default 1,000). */
  readonly pageSize?: number;
  /** Pages kept, least recently used out first (default 50, about 50K rows). */
  readonly maxPages?: number;
  /** Concurrent `ensureRange` page requests (default 4). */
  readonly maxInFlight?: number;
  /**
   * Quiet time before a changed range is fetched (default 50 ms). The first
   * request after a quiet spell goes out at once; during fast drags only the
   * landing range is fetched.
   */
  readonly debounceMs?: number;
  /** Extra rows above and below the requested range to fetch ahead (default 100). */
  readonly prefetchRows?: number;
  /** A failed page is not retried before this many ms (default 1,000). */
  readonly retryMs?: number;
  /** Clock for the debounce and retry (tests). */
  readonly now?: () => number;
}

interface Page {
  readonly columns: PageColumns;
  readonly rows: number;
  lastUsed: number;
}

interface PageRequest {
  readonly page: number;
  readonly controller: AbortController;
  /** `loadRange` callers waiting on this page; pinned requests are never cancelled as stale. */
  pins: number;
  readonly done: Promise<void>;
}

function abortError(): Error {
  const error = new Error('The page request was cancelled.');
  error.name = 'AbortError';
  return error;
}

/**
 * Paging, caching and request management shared by `ArrowPagedSource` and
 * `SyntheticSource`: 1,000-row pages in an LRU of 50, coalesced and
 * debounced fetches for the visible window, at most N in flight, stale
 * requests cancelled through their AbortSignal, and a `reset()` that drops
 * everything when the view (sort/filters) changes.
 */
export abstract class PagedGridSource implements GridDataSource {
  readonly pageSize: number;
  readonly maxPages: number;
  readonly maxInFlight: number;
  readonly debounceMs: number;
  readonly prefetchRows: number;
  readonly retryMs: number;

  private _rowCount: number;
  private _columns: readonly GridColumn[];
  private readonly pages = new Map<number, Page>();
  private readonly requests = new Map<number, PageRequest>();
  private readonly failedAt = new Map<number, number>();
  private readonly listeners = new Set<GridSourceListener>();
  private readonly now: () => number;
  private tick = 0;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastRangeChange = Number.NEGATIVE_INFINITY;
  // The wanted range (pages, inclusive) and the rows actually asked for, for ordering.
  private wantFirst = 0;
  private wantLast = -1;
  private askedFirst = 0;
  private askedLast = -1;
  // One-page lookup cache for getCell.
  private lastIndex = -1;
  private lastPage: Page | undefined;

  protected constructor(options: PagedSourceOptions) {
    this._columns = options.columns;
    this._rowCount = Math.max(0, Math.floor(options.rowCount));
    this.pageSize = options.pageSize ?? PAGE_SIZE;
    this.maxPages = Math.max(1, options.maxPages ?? 50);
    this.maxInFlight = Math.max(1, options.maxInFlight ?? 4);
    this.debounceMs = options.debounceMs ?? 50;
    this.prefetchRows = options.prefetchRows ?? 100;
    this.retryMs = options.retryMs ?? 1_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** Fetches rows `offset..offset+limit-1` as display values, column by column. */
  protected abstract loadPage(offset: number, limit: number, signal: AbortSignal): Promise<PageColumns>;

  get rowCount(): number {
    return this._rowCount;
  }

  get columns(): readonly GridColumn[] {
    return this._columns;
  }

  /** Pages currently cached (for tests and diagnostics). */
  get cachedPages(): number[] {
    return [...this.pages.keys()].sort((a, b) => a - b);
  }

  /** Pages currently being fetched (for tests and diagnostics). */
  get inFlightPages(): number[] {
    return [...this.requests.keys()].sort((a, b) => a - b);
  }

  getCell(row: number, col: number): GridCell | undefined {
    const index = Math.floor(row / this.pageSize);
    let page: Page | undefined;
    if (index === this.lastIndex) page = this.lastPage;
    else {
      page = this.pages.get(index);
      this.lastIndex = index;
      this.lastPage = page;
    }
    if (page === undefined) return undefined;
    const column = page.columns[col];
    if (column === undefined) return undefined;
    const value = column[row - index * this.pageSize];
    return value === undefined ? undefined : value;
  }

  isRowLoaded(row: number): boolean {
    return this.pages.has(Math.floor(row / this.pageSize));
  }

  subscribe(listener: GridSourceListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  ensureRange(firstRow: number, lastRow: number): void {
    if (this._rowCount === 0 || lastRow < firstRow) return;
    const first = Math.max(0, Math.min(this._rowCount - 1, Math.floor(firstRow)));
    const last = Math.max(first, Math.min(this._rowCount - 1, Math.floor(lastRow)));
    const firstPage = Math.floor(Math.max(0, first - this.prefetchRows) / this.pageSize);
    const lastPage = Math.floor(Math.min(this._rowCount - 1, last + this.prefetchRows) / this.pageSize);
    this.askedFirst = first;
    this.askedLast = last;
    // Touch what is on screen so the LRU keeps it.
    const visibleFirst = Math.floor(first / this.pageSize);
    const visibleLast = Math.floor(last / this.pageSize);
    for (let p = visibleFirst; p <= visibleLast; p += 1) {
      const page = this.pages.get(p);
      if (page) page.lastUsed = ++this.tick;
    }
    if (firstPage === this.wantFirst && lastPage === this.wantLast) {
      // Same pages: nothing new to ask for unless a retry is due.
      if (this.timer === null && this.hasMissingWanted()) this.schedule();
      return;
    }
    this.wantFirst = firstPage;
    this.wantLast = lastPage;
    this.schedule();
  }

  private schedule(): void {
    const now = this.now();
    const quiet = this.timer === null && now - this.lastRangeChange >= this.debounceMs;
    this.lastRangeChange = now;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (quiet) {
      this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  private hasMissingWanted(): boolean {
    for (let p = this.wantFirst; p <= this.wantLast; p += 1) {
      if (!this.pages.has(p) && !this.requests.has(p)) return true;
    }
    return false;
  }

  /** Cancels requests nobody wants any more, then starts wanted pages up to the in-flight cap. */
  private flush(): void {
    for (const request of [...this.requests.values()]) {
      if (request.pins === 0 && (request.page < this.wantFirst || request.page > this.wantLast)) {
        this.requests.delete(request.page);
        request.controller.abort(abortError());
      }
    }
    this.pump();
  }

  private pump(): void {
    if (this.wantLast < this.wantFirst) return;
    // Nearest the middle of the asked-for rows first, so the visible rows come in before prefetch.
    const centre = Math.floor((this.askedFirst + this.askedLast) / 2 / this.pageSize);
    const now = this.now();
    while (this.activeRequests() < this.maxInFlight) {
      let best = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let p = this.wantFirst; p <= this.wantLast; p += 1) {
        if (this.pages.has(p) || this.requests.has(p)) continue;
        const failed = this.failedAt.get(p);
        if (failed !== undefined && now - failed < this.retryMs) continue;
        const distance = Math.abs(p - centre);
        if (distance < bestDistance) {
          best = p;
          bestDistance = distance;
        }
      }
      if (best < 0) return;
      this.request(best);
    }
  }

  private activeRequests(): number {
    let count = 0;
    for (const request of this.requests.values()) if (request.pins === 0) count += 1;
    return count;
  }

  private request(page: number): PageRequest {
    const controller = new AbortController();
    const generation = this.generation;
    const offset = page * this.pageSize;
    const limit = Math.min(this.pageSize, this._rowCount - offset);
    const done = this.loadPage(offset, limit, controller.signal).then(
      (columns) => {
        if (generation !== this.generation || controller.signal.aborted) throw abortError();
        if (this.requests.get(page)?.controller === controller) this.requests.delete(page);
        this.failedAt.delete(page);
        this.store(page, columns, limit);
        this.emit({ kind: 'rows', firstRow: offset, lastRow: offset + limit - 1 });
        this.pump();
      },
      (error: unknown) => {
        if (this.requests.get(page)?.controller === controller) this.requests.delete(page);
        if (generation !== this.generation || controller.signal.aborted) throw abortError();
        this.failedAt.set(page, this.now());
        this.emit({ kind: 'error', firstRow: offset, lastRow: offset + limit - 1, error });
        this.pump();
        throw error;
      },
    );
    // ensureRange requests have no awaiting caller; keep their rejections handled.
    done.catch(() => undefined);
    const request: PageRequest = { page, controller, pins: 0, done };
    this.requests.set(page, request);
    return request;
  }

  private store(page: number, columns: PageColumns, rows: number): void {
    this.pages.set(page, { columns, rows, lastUsed: ++this.tick });
    if (page === this.lastIndex) this.lastIndex = -1;
    while (this.pages.size > this.maxPages) {
      let oldest = -1;
      let oldestUsed = Number.POSITIVE_INFINITY;
      for (const [index, cached] of this.pages) {
        if (cached.lastUsed < oldestUsed) {
          oldest = index;
          oldestUsed = cached.lastUsed;
        }
      }
      if (oldest < 0) break;
      this.pages.delete(oldest);
      if (oldest === this.lastIndex) this.lastIndex = -1;
    }
  }

  async loadRange(firstRow: number, lastRow: number, signal?: AbortSignal): Promise<void> {
    if (this._rowCount === 0 || lastRow < firstRow) return;
    if (signal?.aborted) throw abortError();
    const first = Math.floor(Math.max(0, firstRow) / this.pageSize);
    const last = Math.floor(Math.min(this._rowCount - 1, lastRow) / this.pageSize);
    const pinned: PageRequest[] = [];
    const waits: Promise<void>[] = [];
    for (let p = first; p <= last; p += 1) {
      const cached = this.pages.get(p);
      if (cached) {
        cached.lastUsed = ++this.tick;
        continue;
      }
      const request = this.requests.get(p) ?? this.request(p);
      request.pins += 1;
      pinned.push(request);
      waits.push(request.done);
    }
    const unpin = () => {
      for (const request of pinned.splice(0)) {
        request.pins -= 1;
        if (request.pins === 0 && (request.page < this.wantFirst || request.page > this.wantLast) && this.requests.get(request.page) === request) {
          this.requests.delete(request.page);
          request.controller.abort(abortError());
        }
      }
    };
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => undefined);
    try {
      await Promise.race([Promise.all(waits), aborted]);
      // Freshen everything we waited for so it is still cached when the caller reads it.
      for (let p = first; p <= last; p += 1) {
        const page = this.pages.get(p);
        if (page) page.lastUsed = ++this.tick;
      }
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      unpin();
    }
  }

  /**
   * Drops every page and cancels every request (new sort or filters), and
   * optionally swaps the row count and columns. Late pages of the old view
   * are discarded.
   */
  reset(next: { rowCount?: number; columns?: readonly GridColumn[] } = {}): void {
    this.generation += 1;
    for (const request of this.requests.values()) request.controller.abort(abortError());
    this.requests.clear();
    this.pages.clear();
    this.failedAt.clear();
    this.lastIndex = -1;
    this.lastPage = undefined;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.lastRangeChange = Number.NEGATIVE_INFINITY;
    this.wantFirst = 0;
    this.wantLast = -1;
    if (next.rowCount !== undefined) this._rowCount = Math.max(0, Math.floor(next.rowCount));
    if (next.columns !== undefined) this._columns = next.columns;
    this.emit({ kind: 'reset' });
  }

  /** Changes the row count (e.g. when the count arrives after the first page) without dropping pages. */
  setRowCount(rowCount: number): void {
    const next = Math.max(0, Math.floor(rowCount));
    if (next === this._rowCount) return;
    this._rowCount = next;
    this.emit({ kind: 'resize' });
  }

  /** Cancels everything; the source is unusable afterwards. */
  dispose(): void {
    this.reset();
    this.listeners.clear();
  }

  protected emit(change: GridSourceChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

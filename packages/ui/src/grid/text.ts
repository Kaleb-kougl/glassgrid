/*
 * Text measurement for the canvas grid without per-frame allocation.
 * `measureText` allocates a TextMetrics object per call, so widths come
 * from per-font advance tables (ASCII measured once, other characters once
 * each, kerning off on the paint context so sums are exact), and truncated
 * strings are cached per column width.
 */

export interface MeasureContext {
  font: string;
  measureText(text: string): { readonly width: number };
}

export const ELLIPSIS = '…';

/** Advance widths of one font. */
export class FontMetrics {
  readonly font: string;
  private readonly ascii = new Float64Array(128).fill(-1);
  private readonly other = new Map<number, number>();
  private readonly ctx: MeasureContext | null;
  /** Width of the ellipsis character. */
  readonly ellipsis: number;
  /** Width of the digit 0 (row numbers, gutter sizing). */
  readonly digit: number;

  constructor(font: string, ctx: MeasureContext | null) {
    this.font = font;
    this.ctx = ctx;
    this.ellipsis = this.charWidth(ELLIPSIS.charCodeAt(0));
    this.digit = this.charWidth(48);
  }

  private measure(code: number): number {
    const ctx = this.ctx;
    if (!ctx) return code < 32 ? 0 : 7;
    const previous = ctx.font;
    ctx.font = this.font;
    const width = ctx.measureText(String.fromCharCode(code)).width;
    ctx.font = previous;
    return Number.isFinite(width) ? width : 7;
  }

  charWidth(code: number): number {
    if (code < 128) {
      const cached = this.ascii[code] ?? -1;
      if (cached >= 0) return cached;
      const width = this.measure(code);
      this.ascii[code] = width;
      return width;
    }
    const cached = this.other.get(code);
    if (cached !== undefined) return cached;
    const width = this.measure(code);
    this.other.set(code, width);
    return width;
  }

  /** Width of `text` in px. Allocation-free once its characters have been seen. */
  width(text: string): number {
    let total = 0;
    for (let i = 0; i < text.length; i += 1) total += this.charWidth(text.charCodeAt(i));
    return total;
  }

  /**
   * `text` cut to fit `max` px with a trailing ellipsis (the whole text when
   * it fits; just the ellipsis when nothing else fits). Allocates only when
   * it has to cut.
   */
  fit(text: string, max: number): string {
    if (max <= 0) return '';
    let total = 0;
    for (let i = 0; i < text.length; i += 1) total += this.charWidth(text.charCodeAt(i));
    if (total <= max) return text;
    const room = max - this.ellipsis;
    if (room <= 0) return this.ellipsis <= max ? ELLIPSIS : '';
    let used = 0;
    let cut = 0;
    while (cut < text.length) {
      const next = used + this.charWidth(text.charCodeAt(cut));
      if (next > room) break;
      used = next;
      cut += 1;
    }
    // Do not split a surrogate pair.
    if (cut > 0 && cut < text.length) {
      const code = text.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    return `${text.slice(0, cut).trimEnd()}${ELLIPSIS}`;
  }
}

/** Fitted strings of one column at one width and font; dropped when either changes. */
export class FitCache {
  private readonly map = new Map<string, string>();
  private width = -1;
  private metrics: FontMetrics | null = null;
  readonly limit: number;

  constructor(limit = 4_096) {
    this.limit = limit;
  }

  /** `text` fitted to `max` px in `metrics`' font. */
  get(text: string, max: number, metrics: FontMetrics): string {
    if (max !== this.width || metrics !== this.metrics) {
      this.map.clear();
      this.width = max;
      this.metrics = metrics;
    }
    const cached = this.map.get(text);
    if (cached !== undefined) return cached;
    const fitted = metrics.fit(text, max);
    if (this.map.size >= this.limit) this.map.clear();
    this.map.set(text, fitted);
    return fitted;
  }

  clear(): void {
    this.map.clear();
    this.width = -1;
    this.metrics = null;
  }

  get size(): number {
    return this.map.size;
  }
}

/** Row-number labels for the rows on screen, recycled in a small ring. */
export class RowLabels {
  private readonly rows: Float64Array;
  private readonly labels: string[];
  private readonly mask: number;

  constructor(size = 256) {
    const capacity = 1 << Math.ceil(Math.log2(Math.max(2, size)));
    this.rows = new Float64Array(capacity).fill(-1);
    this.labels = new Array<string>(capacity).fill('');
    this.mask = capacity - 1;
  }

  /** The 1-based label of 0-based `row`. */
  get(row: number): string {
    const slot = row & this.mask;
    if (this.rows[slot] === row) return this.labels[slot] ?? '';
    const label = String(row + 1);
    this.rows[slot] = row;
    this.labels[slot] = label;
    return label;
  }
}

import type { TooltipRow } from '../components/Tooltip.js';
import type { ResolvedTokens } from '../tokens.js';
import type { Axes } from './axes.js';
import type { BrushDims, Snapper } from './brush.js';
import type { ChartFonts } from './canvas.js';
import type { TimeResolution } from './format.js';
import type { AxisKind } from './types.js';

/** What the pointer is over: tooltip content and an overlay highlight. */
export interface HoverInfo {
  /** Tooltip anchor in CSS px of the chart canvas. */
  readonly anchor: { readonly x: number; readonly y: number };
  readonly title: string;
  readonly rows: readonly TooltipRow[];
  /** Draws the hover highlight (crosshair, ring, outline) on the overlay canvas. */
  readonly highlight?: (ctx: CanvasRenderingContext2D, dc: DrawContext) => void;
}

/** Context every model's draw functions receive. */
export interface DrawContext {
  readonly tokens: ResolvedTokens;
  readonly fonts: ChartFonts;
  readonly dpr: number;
}

/**
 * A laid-out chart for one size: scales, draw functions and hit-testing.
 * Built by each mark (`build*Model`) and driven by `ChartFrame`.
 */
export interface ChartModel {
  readonly axes: Axes;
  readonly xKind: Exclude<AxisKind, 'category'>;
  readonly yKind: Exclude<AxisKind, 'category'>;
  readonly xResolution: TimeResolution;
  readonly yResolution: TimeResolution;
  /** Brush shape, or null when the chart does not brush. */
  readonly brushDims: BrushDims | null;
  readonly snapX: Snapper | null;
  readonly snapY: Snapper | null;
  /** Gridlines, baseline, tick labels: never dimmed. */
  drawBackground(ctx: CanvasRenderingContext2D, dc: DrawContext): void;
  /** The marks at full strength; ChartFrame dims what lies outside a selection. */
  drawMarks(ctx: CanvasRenderingContext2D, dc: DrawContext): void;
  hitTest(px: number, py: number): HoverInfo | null;
}

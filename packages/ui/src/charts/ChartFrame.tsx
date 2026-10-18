import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { Tooltip } from '../components/Tooltip.js';
import type { ResolvedTokens } from '../tokens.js';
import { crisp } from './axes.js';
import {
  beginDrag,
  brushRect,
  brushToSelection,
  dragBrush,
  dragMoved,
  endDrag,
  hitBrushTarget,
  keyBrush,
  sameBrush,
  selectionToBrush,
  type Brush,
  type BrushAxes,
  type BrushDrag,
} from './brush.js';
import { chartFonts, createLayer, devicePixelRatioNow, sizeCanvas, type ChartFonts, type Layer } from './canvas.js';
import { formatRange } from './format.js';
import { useElementWidth, useFontsVersion } from './hooks.js';
import type { ChartModel, DrawContext, HoverInfo } from './model.js';
import { chartPerfHook } from './perf.js';
import type { BrushHandler, IntervalSelection } from './types.js';

export interface ChartFrameProps {
  /** Builds the model for a size; memoize it on data, tokens and options. */
  build: (width: number, height: number, fonts: ChartFonts) => ChartModel;
  tokens: ResolvedTokens;
  /** Canvas height, CSS px. */
  height: number;
  /** Accessible summary: mark, fields and row count. The current selection is appended. */
  summary: string;
  /** This chart's own selection (controlled), in data space. */
  selection?: IntervalSelection | null;
  /** Brush callback; without it the chart does not brush. */
  onBrush?: BrushHandler;
  /** Name of the x field, for selection announcements. */
  xLabel: string;
  /** Name of the y field (2-D brushes). */
  yLabel?: string;
  /** Marks are drawn elsewhere (the shared WebGL overlay): draw axes and the brush only. */
  marksExternal?: boolean;
  /** Called with the active brush on every painted frame (the WebGL scatter syncs its uniforms). */
  onFrame?: (brush: Brush | null, model: ChartModel) => void;
  /** The canvas the plot is drawn on (the WebGL scatter places its viewport from it). */
  onCanvas?: (canvas: HTMLCanvasElement | null, model: ChartModel | null) => void;
  /** Rendered under the plot (legend). */
  legend?: ReactNode;
  /** Visually hidden data table for screen readers. */
  dataTable?: ReactNode;
  /** Name in benchmark timings. */
  perfName?: string;
  /** Called after the layers were rebuilt and painted (new model or theme). */
  onDrawn?: () => void;
  testId?: string;
}

/** How long a committed brush is shown while waiting for the `selection` prop to catch up. */
const PENDING_MS = 1000;

/** Brush handle bar: 1/3 of the plot height, at least 14 px. */
function drawBrush(ctx: CanvasRenderingContext2D, brush: Brush, axes: BrushAxes, tokens: ResolvedTokens, dpr: number): void {
  const r = brushRect(brush, axes);
  const { plot } = axes;
  const left = Math.max(plot.left, r.left);
  const right = Math.min(plot.left + plot.width, r.right);
  const top = Math.max(plot.top, r.top);
  const bottom = Math.min(plot.top + plot.height, r.bottom);
  if (right < left || bottom < top) return;
  ctx.fillStyle = tokens.chart.brushFill;
  ctx.fillRect(left, top, right - left, bottom - top);
  ctx.strokeStyle = tokens.chart.brushStroke;
  ctx.lineWidth = 1;
  ctx.strokeRect(crisp(left, dpr), crisp(top, dpr), crisp(right, dpr) - crisp(left, dpr), crisp(bottom, dpr) - crisp(top, dpr));
  ctx.fillStyle = tokens.chart.brushStroke;
  const hw = tokens.chart.brushHandleW;
  if (axes.dims === 'x') {
    const h = Math.max(14, (bottom - top) / 3);
    const y = top + (bottom - top - h) / 2;
    for (const x of [left, right]) ctx.fillRect(x - hw / 2, y, hw, h);
  } else {
    const s = hw + 2;
    for (const [x, y] of [
      [left, top],
      [right, top],
      [left, bottom],
      [right, bottom],
    ] as const) {
      ctx.fillRect(x - s / 2, y - s / 2, s, s);
    }
  }
}

const CURSORS: Record<string, string> = {
  x0: 'ew-resize',
  x1: 'ew-resize',
  y0: 'ns-resize',
  y1: 'ns-resize',
  'x0,y0': 'nesw-resize',
  'x1,y1': 'nesw-resize',
  'x0,y1': 'nwse-resize',
  'x1,y0': 'nwse-resize',
};

/** Text of a brush for announcements and the accessible summary. */
export function describeBrush(brush: Brush | null, model: ChartModel, xLabel: string, yLabel?: string): string {
  if (!brush) return 'No selection.';
  const x = `${xLabel} ${formatRange(brush.x0, brush.x1, model.xKind, model.xResolution)}`;
  if (brush.y0 === undefined || brush.y1 === undefined) return `Selected ${x}.`;
  return `Selected ${x} and ${yLabel ?? 'y'} ${formatRange(brush.y0, brush.y1, model.yKind, model.yResolution)}.`;
}

/**
 * The shared chart shell: sizes the canvases, builds the model, caches the
 * background and marks as offscreen layers, and composites them per frame
 * with the active brush (marks outside it at the token's unselected
 * opacity, the brush outlined with handles). Hover tooltips come from the
 * model's hit test; brushing is controlled through `selection` / `onBrush`.
 *
 * While a brush is dragged only the composite runs (a few blits, no
 * re-render), so the overlay keeps up with the pointer regardless of the
 * mark count.
 */
export function ChartFrame({
  build,
  tokens,
  height,
  summary,
  selection,
  onBrush,
  xLabel,
  yLabel,
  marksExternal = false,
  onFrame,
  onCanvas,
  legend,
  dataTable,
  perfName = 'chart',
  onDrawn,
  testId,
}: ChartFrameProps) {
  const plotRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const topRef = useRef<HTMLCanvasElement>(null);
  const width = useElementWidth(plotRef);
  const fontsVersion = useFontsVersion();
  const helpId = useId();
  const fonts = useMemo(() => chartFonts(tokens), [tokens]);
  const model = useMemo(
    () => (width > 0 ? build(width, height, fonts) : null),
    // fontsVersion: re-measure tick labels once the webfonts are in.
    [build, width, height, fonts, fontsVersion], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const layers = useRef<{ bg: Layer | null; marks: Layer | null }>({ bg: null, marks: null });
  const drag = useRef<BrushDrag | null>(null);
  /** A brush shown instead of the `selection` prop: while dragging, and briefly after a commit. */
  const draft = useRef<{ brush: Brush | null } | null>(null);
  const lastEmitted = useRef<Brush | null>(null);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const frame = useRef<number | null>(null);
  const hoverRef = useRef<HoverInfo | null>(null);
  /** The hovered mark and where the plot sits in the chart (tooltip coordinates). */
  const [hover, setHover] = useState<{ info: HoverInfo; offsetX: number; offsetY: number } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  /** The draft as render state, for the accessible label (the ref drives painting). */
  const [shownDraft, setShownDraft] = useState<{ brush: Brush | null } | null>(null);

  const selectionKey = JSON.stringify(selection ?? null);
  const xKind = model?.xKind ?? 'number';
  const yKind = model?.yKind ?? 'number';
  const dims = model?.brushDims ?? 'x';
  const propBrush = useMemo(() => selectionToBrush(selection, xKind, yKind, dims), [selectionKey, xKind, yKind, dims]); // eslint-disable-line react-hooks/exhaustive-deps

  const brushAxes = useMemo((): BrushAxes | null => {
    if (!model?.brushDims) return null;
    return { x: model.axes.x, y: model.axes.y, plot: model.axes.layout.plot, dims: model.brushDims, snapX: model.snapX, snapY: model.snapY };
  }, [model]);

  /** Latest render inputs for the stable paint function (selection changes repaint without rebuilding layers). */
  const live = useRef({ model, brushAxes, propBrush, marksExternal, tokens, fonts, onFrame, perfName, onDrawn });
  useLayoutEffect(() => {
    live.current = { model, brushAxes, propBrush, marksExternal, tokens, fonts, onFrame, perfName, onDrawn };
  });

  const activeBrush = useCallback((): Brush | null => (draft.current ? draft.current.brush : live.current.propBrush), []);

  /** Composites a frame: background, marks (dimmed outside the brush), brush and hover overlay. */
  const paintNow = useCallback(() => {
    frame.current = null;
    const { model: m, brushAxes: axes, marksExternal: external, tokens: t, fonts: f, onFrame: frameHook, perfName: name } = live.current;
    const base = baseRef.current;
    const top = topRef.current;
    if (!m || !base || !top) return;
    const start = performance.now();
    const dpr = devicePixelRatioNow();
    const { width: w, height: h } = m.axes.layout;
    const ctx = sizeCanvas(base, w, h, dpr);
    const overlay = sizeCanvas(top, w, h, dpr);
    const brush = axes ? activeBrush() : null;
    if (ctx) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, base.width, base.height);
      const { bg, marks } = layers.current;
      if (bg) ctx.drawImage(bg.canvas, 0, 0);
      if (marks && !external) {
        if (brush && axes) {
          ctx.globalAlpha = t.chart.unselectedOpacity;
          ctx.drawImage(marks.canvas, 0, 0);
          ctx.globalAlpha = 1;
          const r = brushRect(brush, axes);
          ctx.save();
          ctx.beginPath();
          ctx.rect(r.left * dpr, r.top * dpr, (r.right - r.left) * dpr, (r.bottom - r.top) * dpr);
          ctx.clip();
          ctx.drawImage(marks.canvas, 0, 0);
          ctx.restore();
        } else {
          ctx.drawImage(marks.canvas, 0, 0);
        }
      }
    }
    if (overlay) {
      overlay.clearRect(0, 0, w, h);
      const dc: DrawContext = { tokens: t, fonts: f, dpr };
      if (brush && axes) drawBrush(overlay, brush, axes, t, dpr);
      const current = hoverRef.current;
      if (current?.highlight && !drag.current) current.highlight(overlay, dc);
    }
    frameHook?.(brush, m);
    chartPerfHook()?.('paint', name, performance.now() - start);
  }, [activeBrush]);

  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => paintNow());
  }, [paintNow]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      if (pendingTimer.current !== null) clearTimeout(pendingTimer.current);
    },
    [],
  );

  // Layers: rebuilt when the model (data, size, fonts) or theme changes, then painted at once.
  useLayoutEffect(() => {
    if (!model) return;
    const start = performance.now();
    const dpr = devicePixelRatioNow();
    const { width: w, height: h } = model.axes.layout;
    const dc: DrawContext = { tokens, fonts, dpr };
    const bg = createLayer(w, h, dpr, layers.current.bg);
    if (bg) model.drawBackground(bg.ctx, dc);
    const marks = marksExternal ? null : createLayer(w, h, dpr, layers.current.marks);
    if (marks) model.drawMarks(marks.ctx, dc);
    layers.current = { bg, marks };
    chartPerfHook()?.('layers', perfName, performance.now() - start);
    paintNow();
    live.current.onDrawn?.();
  }, [model, tokens, fonts, marksExternal, paintNow, perfName]);

  useEffect(() => {
    onCanvas?.(baseRef.current, model);
  }, [onCanvas, model]);

  // The frame hook changed (e.g. the scatter switched to WebGL): hand it the current brush.
  useEffect(() => {
    schedule();
  }, [onFrame, schedule]);

  // A new selection from the store replaces any committed draft (not one being dragged).
  useEffect(() => {
    if (drag.current) return;
    draft.current = null;
    setShownDraft(null);
    lastEmitted.current = propBrush;
    schedule();
  }, [propBrush, schedule]);

  const emit = useCallback(
    (brush: Brush | null, phase: 'move' | 'end') => {
      if (!onBrush || !model) return;
      if (phase === 'move' && sameBrush(brush, lastEmitted.current)) return;
      lastEmitted.current = brush;
      onBrush(brush ? brushToSelection(brush, model.xKind, model.yKind) : null, phase);
    },
    [onBrush, model],
  );

  const commit = useCallback(
    (brush: Brush | null) => {
      draft.current = { brush };
      if (pendingTimer.current !== null) clearTimeout(pendingTimer.current);
      pendingTimer.current = setTimeout(() => {
        pendingTimer.current = null;
        if (drag.current) return;
        draft.current = null;
        setShownDraft(null);
        schedule();
      }, PENDING_MS);
      emit(brush, 'end');
      if (model) setAnnouncement(brush ? describeBrush(brush, model, xLabel, yLabel) : 'Selection cleared.');
      setShownDraft({ brush });
      schedule();
    },
    [emit, schedule, model, xLabel, yLabel],
  );

  const pointOf = (event: { clientX: number; clientY: number }) => {
    const rect = topRef.current?.getBoundingClientRect();
    return rect ? { x: event.clientX - rect.left, y: event.clientY - rect.top } : { x: 0, y: 0 };
  };

  const canBrush = Boolean(onBrush && brushAxes);

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!canBrush || !brushAxes || event.button !== 0) return;
    const p = pointOf(event);
    drag.current = beginDrag(activeBrush(), brushAxes, p.x, p.y);
    // No preventDefault: the press focuses the plot (a tab stop) the way a click does, without a focus ring.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // No pointer capture (jsdom, or the pointer is already gone).
    }
    hoverRef.current = null;
    setHover(null);
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const p = pointOf(event);
    const current = drag.current;
    if (current && brushAxes) {
      if (!dragMoved(current, p.x, p.y)) return;
      const brush = dragBrush(current, brushAxes, p.x, p.y);
      draft.current = { brush };
      schedule();
      emit(brush, 'move');
      return;
    }
    if (!model) return;
    const info = model.hitTest(p.x, p.y);
    if (info !== hoverRef.current) {
      hoverRef.current = info;
      const plot = plotRef.current;
      // Tooltip coordinates are relative to .gg-chart; the plot sits inside its padding.
      setHover(info ? { info, offsetX: plot?.offsetLeft ?? 0, offsetY: plot?.offsetTop ?? 0 } : null);
      schedule();
    }
    const target = canBrush && brushAxes ? hitBrushTarget(activeBrush(), brushAxes, p.x, p.y) : null;
    const cursor = !canBrush ? 'default' : target === null ? 'crosshair' : target.kind === 'inside' ? 'move' : (CURSORS[target.edges.join(',')] ?? 'move');
    if (event.currentTarget.style.cursor !== cursor) event.currentTarget.style.cursor = cursor;
  };

  const finishDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    const current = drag.current;
    if (!current || !brushAxes) return;
    drag.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Not captured.
    }
    const p = pointOf(event);
    const brush = endDrag(current, brushAxes, p.x, p.y);
    // A click with no brush before and none after changes nothing.
    if (current.kind === 'create' && !current.previous && !brush) return;
    commit(brush);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canBrush || !brushAxes) return;
    const result = keyBrush(activeBrush(), brushAxes, event.key, event.shiftKey);
    if (!result.handled) return;
    event.preventDefault();
    event.stopPropagation();
    commit(result.brush);
  };

  const brushNow = model && brushAxes ? (shownDraft ? shownDraft.brush : propBrush) : null;
  const label = model ? `${summary} ${describeBrush(brushNow, model, xLabel, yLabel)}` : summary;

  return (
    <div className="gg-chart" data-testid={testId}>
      <div
        ref={plotRef}
        className="gg-chart__plot"
        role="img"
        aria-label={label}
        aria-describedby={canBrush ? helpId : undefined}
        tabIndex={0}
        onKeyDown={onKeyDown}
        style={{ height }}
        data-testid={testId ? `${testId}-plot` : undefined}
      >
        <canvas ref={baseRef} className="gg-chart__base" aria-hidden="true" />
        <canvas
          ref={topRef}
          className="gg-chart__top"
          aria-hidden="true"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishDrag}
          onPointerCancel={finishDrag}
          onPointerLeave={() => {
            if (drag.current) return;
            hoverRef.current = null;
            setHover(null);
            schedule();
          }}
          onDoubleClick={() => {
            if (!canBrush) return;
            drag.current = null;
            if (activeBrush()) commit(null);
          }}
          data-testid={testId ? `${testId}-canvas` : undefined}
        />
      </div>
      {canBrush && (
        <span id={helpId} className="gg-visually-hidden">
          {dims === 'xy'
            ? 'Drag to select a region. Enter creates a selection, arrow keys move it, Shift with arrow keys resizes it, Escape clears it.'
            : 'Drag to select a range. Enter creates a selection, Left and Right move it, Shift with Left or Right resizes it, Escape clears it.'}
        </span>
      )}
      <div className="gg-visually-hidden" aria-live="polite" data-testid={testId ? `${testId}-live` : undefined}>
        {announcement}
      </div>
      {legend}
      {dataTable !== undefined && <div className="gg-visually-hidden">{dataTable}</div>}
      {hover && (
        <Tooltip anchor={{ x: hover.info.anchor.x + hover.offsetX, y: hover.info.anchor.y + hover.offsetY }} title={hover.info.title} rows={hover.info.rows} />
      )}
    </div>
  );
}

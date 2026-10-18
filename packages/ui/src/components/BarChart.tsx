import type { Table } from 'apache-arrow';
import { scaleBand, scaleLinear } from 'd3-scale';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { FilterValue } from '@glassgrid/core';
import { chartColumnsFromArrow } from '../charts/arrow.js';
import { barPath, chartFonts, ellipsize, measuringContext, sizeCanvas, type ChartFonts } from '../charts/canvas.js';
import { seriesColors } from '../charts/colors.js';
import { formatAggregate } from '../charts/format.js';
import { useFontsVersion } from '../charts/hooks.js';
import { SeriesLegend } from '../charts/Legend.js';
import { chartPerfHook } from '../charts/perf.js';
import type { ChartSeries } from '../charts/types.js';
import type { ResolvedTokens } from '../tokens.js';
import { Tooltip, type Point, type TooltipRow } from './Tooltip.js';

export { formatAggregate };

/** One colour series' share of a bar (bar charts with a colour field). */
export interface BarSegment {
  /** Index into the chart's `series`. */
  readonly series: number;
  readonly value: number | null;
}

export interface BarDatum {
  /** Stable identity of the category (e.g. its JSON value). */
  readonly key: string;
  /** Category label as shown; `null` categories pass `isNull`. */
  readonly label: string;
  readonly isNull?: boolean;
  /** The aggregate (the bar's total with segments), or null when the group has none (e.g. sum of only NULLs). */
  readonly value: number | null;
  /** The x value as an `in` filter value (set by `barDataFromArrow`). */
  readonly filterValue?: FilterValue;
  /** Per-series parts, stacked left to right in series order. */
  readonly segments?: readonly BarSegment[];
}

export interface BarChartProps {
  data: readonly BarDatum[];
  /** Keys of the bars in this chart's own selection. */
  selected: ReadonlySet<string>;
  /** Click, Enter or Space on a bar. */
  onToggle?: (datum: BarDatum) => void;
  /** Resolved tokens of the current theme (canvas cannot read CSS variables). */
  tokens: ResolvedTokens;
  /** Name of the measure in tooltips, e.g. `count(*)` or `sum(fare_amount)`. */
  valueLabel: string;
  /** Accessible name of the chart. */
  label: string;
  formatValue?: (value: number) => string;
  /** Colour series of segmented bars (from `barDataFromArrow`). */
  series?: readonly ChartSeries[];
  /** Name of the colour field, for the legend. */
  colorLabel?: string;
  /** Series keys in palette order, to keep colours stable across re-queries. */
  colorKeys?: readonly string[];
  testId?: string;
}

/** Geometry shared by the design: 20px rows, 6px apart, an 84px label column. */
export const BAR_ROW_HEIGHT = 20;
export const BAR_ROW_GAP = 6;
export const BAR_HEIGHT = 16;
export const BAR_LABEL_WIDTH = 84;
const LABEL_GAP = 8;
const VALUE_GAP = 6;
/** Selection outline: 1px gap plus the stroke, on the bar's right edge. */
const SELECTION_ROOM = 4;

export interface BarGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rowTop: number;
}

export interface BarLayout {
  readonly width: number;
  readonly height: number;
  readonly axisX: number;
  readonly bars: readonly BarGeometry[];
  /** Pixels per unit of value. */
  readonly scale: number;
}

/**
 * Pure layout for a horizontal bar chart: one 20px row per datum, bars from
 * the axis scaled to the largest value with room left for the value label.
 * Negative values draw as zero-length bars (their label still shows).
 */
export function layoutBars(data: readonly BarDatum[], width: number, maxValueLabelWidth: number): BarLayout {
  const height = data.length === 0 ? 0 : data.length * BAR_ROW_HEIGHT + (data.length - 1) * BAR_ROW_GAP;
  const axisX = BAR_LABEL_WIDTH + LABEL_GAP;
  const band = scaleBand<number>()
    .domain(data.map((_, i) => i))
    .range([0, height])
    .paddingInner(data.length > 1 ? BAR_ROW_GAP / (BAR_ROW_HEIGHT + BAR_ROW_GAP) : 0);
  const max = Math.max(0, ...data.map((d) => d.value ?? 0));
  const x = scaleLinear()
    .domain([0, max > 0 ? max : 1])
    // Room after the longest bar for the selection outline and the value label.
    .range([0, Math.max(0, width - axisX - 1 - SELECTION_ROOM - VALUE_GAP - maxValueLabelWidth)]);
  const bars = data.map((d, i) => {
    const rowTop = band(i) ?? 0;
    return {
      x: axisX + 1,
      y: rowTop + (BAR_ROW_HEIGHT - BAR_HEIGHT) / 2,
      width: Math.max(0, x(Math.max(0, d.value ?? 0))),
      height: BAR_HEIGHT,
      rowTop,
    };
  });
  return { width, height, axisX, bars, scale: x(1) - x(0) };
}

/** Index of the row under `point` (whole row, label included), or -1. Rows are uniform, so this is a lookup. */
export function hitTestBars(layout: BarLayout, point: Point): number {
  if (point.x < 0 || point.x > layout.width || point.y < 0) return -1;
  const i = Math.floor(point.y / (BAR_ROW_HEIGHT + BAR_ROW_GAP));
  const bar = layout.bars[i];
  return bar && point.y < bar.rowTop + BAR_ROW_HEIGHT ? i : -1;
}

export interface DrawBarsOptions {
  readonly selected: ReadonlySet<string>;
  readonly tokens: ResolvedTokens;
  readonly fonts: ChartFonts;
  readonly formatValue: (value: number) => string;
  /** Colour per series index (segmented bars). */
  readonly colors?: readonly string[];
  /** Keyboard-focused row, or -1. */
  readonly focusIndex?: number;
}

/**
 * Draws the bars: axis rule, category labels (bold when selected, italic
 * for NULL), bars (unselected ones faded while anything is selected),
 * selection outline and the exact value after each bar.
 */
export function drawBars(ctx: CanvasRenderingContext2D, layout: BarLayout, data: readonly BarDatum[], options: DrawBarsOptions): void {
  const { selected, tokens, fonts, formatValue, colors } = options;
  const hasSelection = data.some((d) => selected.has(d.key));
  ctx.textBaseline = 'middle';

  // Axis: one rule along the bars' baseline.
  ctx.fillStyle = tokens.chart.axis;
  ctx.fillRect(layout.axisX, 0, 1, layout.height);

  data.forEach((d, i) => {
    const bar = layout.bars[i];
    if (!bar) return;
    const isSelected = selected.has(d.key);
    const mid = bar.rowTop + BAR_ROW_HEIGHT / 2;

    // Category label, right-aligned in the label column.
    ctx.textAlign = 'right';
    ctx.font = isSelected ? fonts.labelBold : d.isNull ? `italic ${fonts.label}` : fonts.label;
    ctx.fillStyle = isSelected ? tokens.color.textPrimary : d.isNull ? tokens.grid.null : tokens.color.textSecondary;
    ctx.fillText(ellipsize(ctx, d.label, BAR_LABEL_WIDTH), BAR_LABEL_WIDTH, mid);

    // Bar: full strength when selected or when nothing is selected.
    ctx.globalAlpha = hasSelection && !isSelected ? tokens.chart.unselectedOpacity : 1;
    if (d.segments && d.segments.length > 0 && colors) {
      let x = bar.x;
      const last = d.segments.length - 1;
      d.segments.forEach((segment, k) => {
        const w = Math.max(0, (segment.value ?? 0) * layout.scale);
        if (w <= 0) return;
        ctx.fillStyle = colors[segment.series] ?? tokens.chart.mark;
        ctx.beginPath();
        if (k === last) barPath(ctx, x, bar.y, w, bar.height, 2);
        else ctx.rect(x, bar.y, w, bar.height);
        ctx.fill();
        x += w;
      });
    } else if (bar.width > 0) {
      ctx.fillStyle = tokens.chart.mark;
      ctx.beginPath();
      barPath(ctx, bar.x, bar.y, bar.width, bar.height, 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // Selection: outline (never colour alone), 1px outside the bar.
    if (isSelected) {
      const w = tokens.chart.selectionW;
      ctx.strokeStyle = tokens.chart.selectionStroke;
      ctx.lineWidth = w;
      ctx.strokeRect(bar.x - 1 - w / 2, bar.y - 1 - w / 2, Math.max(bar.width, 1) + 2 + w, bar.height + 2 + w);
    }

    // Exact value after the bar.
    ctx.textAlign = 'left';
    ctx.font = isSelected ? fonts.valueBold : fonts.value;
    ctx.fillStyle = isSelected ? tokens.color.textPrimary : tokens.color.textSecondary;
    const outline = isSelected ? 2 + tokens.chart.selectionW : 0;
    ctx.fillText(d.value === null ? '–' : formatValue(d.value), bar.x + bar.width + outline + VALUE_GAP, mid);
  });

  // Keyboard focus: ring around the active row.
  const focus = options.focusIndex ?? -1;
  const focused = layout.bars[focus];
  if (focused) {
    ctx.strokeStyle = tokens.color.focus;
    ctx.lineWidth = 2;
    ctx.strokeRect(1, focused.rowTop - 2, layout.width - 2, BAR_ROW_HEIGHT + 4);
  }
}

/** Bars and colour series of a bar result (`x, y` [+ `color`, `color_other`]). */
export interface BarData {
  readonly rows: readonly BarDatum[];
  readonly series: readonly ChartSeries[];
}

/**
 * Bar rows from the Arrow result. Without colour: one bar per row, in
 * result order (top N by measure). With colour: rows are grouped per x
 * (one segment per series, in series order), bars ordered by total.
 */
export function barDataFromArrow(table: Table): BarData {
  const data = chartColumnsFromArrow(table, 'bar');
  const categories = data.categories ?? [];
  if (!data.series) {
    return {
      rows: categories.map((c, i) => {
        const v = data.y[i] ?? Number.NaN;
        return { key: c.key, label: c.label, isNull: c.isNull, value: Number.isNaN(v) ? null : v, filterValue: c.value };
      }),
      series: [],
    };
  }
  const groups = new Map<string, { label: string; isNull: boolean; value: FilterValue; segments: BarSegment[]; total: number; any: boolean; first: number }>();
  categories.forEach((c, i) => {
    let group = groups.get(c.key);
    if (!group) {
      group = { label: c.label, isNull: c.isNull, value: c.value, segments: [], total: 0, any: false, first: i };
      groups.set(c.key, group);
    }
    const v = data.y[i] ?? Number.NaN;
    group.segments.push({ series: data.series?.[i] ?? 0, value: Number.isNaN(v) ? null : v });
    if (!Number.isNaN(v)) {
      group.total += v;
      group.any = true;
    }
  });
  const rows = [...groups.entries()]
    .sort(([, a], [, b]) => b.total - a.total || a.first - b.first)
    .map(([key, g]): BarDatum => ({
      key,
      label: g.label,
      isNull: g.isNull,
      value: g.any ? g.total : null,
      filterValue: g.value,
      segments: [...g.segments].sort((a, b) => a.series - b.series),
    }));
  return { rows, series: data.seriesList };
}

/**
 * Horizontal bar chart drawn on a canvas with d3-scale and the resolved chart
 * tokens. Selection is shown by an outline and a bold label, not by colour
 * alone; unselected bars fade. Keyboard: the chart is one tab stop (a
 * listbox); arrows move between bars, Enter/Space toggles one.
 */
export function BarChart({
  data,
  selected,
  onToggle,
  tokens,
  valueLabel,
  label,
  formatValue = formatAggregate,
  series,
  colorLabel,
  colorKeys,
  testId,
}: BarChartProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ index: number; point: Point } | null>(null);
  const [active, setActive] = useState(0);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const fontsVersion = useFontsVersion();
  const optionPrefix = useId();
  const fonts = useMemo(() => chartFonts(tokens), [tokens]);
  const colors = useMemo(() => (series && series.length > 0 ? seriesColors(series, tokens, colorKeys) : undefined), [series, tokens, colorKeys]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => setWidth(canvas.parentElement ? canvas.parentElement.clientWidth - 24 : 0);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    if (canvas.parentElement) observer.observe(canvas.parentElement);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    const ctx = measuringContext();
    let maxLabel = 0;
    if (ctx) {
      ctx.font = fonts.valueBold;
      for (const d of data) maxLabel = Math.max(maxLabel, ctx.measureText(d.value === null ? '–' : formatValue(d.value)).width);
    } else {
      maxLabel = Math.max(0, ...data.map((d) => (d.value === null ? 1 : formatValue(d.value).length) * 7));
    }
    return layoutBars(data, width, Math.ceil(maxLabel));
    // fontsVersion: re-measure once the webfonts are in.
  }, [data, width, formatValue, fonts, fontsVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeIndex = Math.min(active, Math.max(0, data.length - 1));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || layout.width <= 0) return;
    const start = performance.now();
    const ctx = sizeCanvas(canvas, layout.width, Math.max(1, layout.height), window.devicePixelRatio || 1);
    if (!ctx) return;
    canvas.style.height = `${layout.height}px`;
    ctx.clearRect(0, 0, layout.width, layout.height);
    drawBars(ctx, layout, data, { selected, tokens, fonts, formatValue, colors, focusIndex: keyboardFocus ? activeIndex : -1 });
    chartPerfHook()?.('paint', 'bar', performance.now() - start);
  }, [layout, data, selected, tokens, fonts, formatValue, colors, keyboardFocus, activeIndex]);

  const pointFromEvent = useCallback((event: { clientX: number; clientY: number }): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (data.length === 0) return;
    let next: number | null = null;
    if (event.key === 'ArrowDown') next = Math.min(data.length - 1, activeIndex + 1);
    else if (event.key === 'ArrowUp') next = Math.max(0, activeIndex - 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = data.length - 1;
    if (next !== null) {
      event.preventDefault();
      setActive(next);
      setKeyboardFocus(true);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const datum = data[activeIndex];
      if (datum) onToggle?.(datum);
    }
  };

  const hovered = hover ? data[hover.index] : undefined;
  const canvasLeft = 12;
  const canvasTop = 14;
  const tooltipRows: TooltipRow[] = [];
  if (hovered) {
    if (hovered.segments && series && series.length > 0) {
      for (const segment of hovered.segments) {
        tooltipRows.push({ label: series[segment.series]?.label ?? '', value: segment.value === null ? '–' : formatValue(segment.value) });
      }
      tooltipRows.push({ label: valueLabel, value: hovered.value === null ? '–' : formatValue(hovered.value) });
    } else {
      tooltipRows.push({ label: valueLabel, value: hovered.value === null ? '–' : formatValue(hovered.value) });
    }
  }

  return (
    // The tooltip sits beside the listbox, not in it: a listbox may only own options (axe aria-required-children).
    <div ref={wrapperRef} className="gg-bar-chart">
      <div
        className="gg-bar-chart__plot"
        role="listbox"
        aria-label={label}
        aria-multiselectable="true"
        aria-activedescendant={data.length > 0 ? `${optionPrefix}-${activeIndex}` : undefined}
        tabIndex={0}
        data-testid={testId}
        onKeyDown={onKeyDown}
        onKeyUp={() => setKeyboardFocus(true)}
        onBlur={() => setKeyboardFocus(false)}
        onMouseDown={() => setKeyboardFocus(false)}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          onMouseMove={(event) => {
            const point = pointFromEvent(event);
            const index = point ? hitTestBars(layout, point) : -1;
            setHover(point && index >= 0 ? { index, point } : null);
          }}
          onMouseLeave={() => setHover(null)}
          onClick={(event) => {
            const point = pointFromEvent(event);
            const index = point ? hitTestBars(layout, point) : -1;
            const datum = data[index];
            if (datum) {
              setActive(index);
              onToggle?.(datum);
            }
          }}
        />
        <div className="gg-visually-hidden">
          {data.map((d, i) => (
            <div
              key={d.key}
              id={`${optionPrefix}-${i}`}
              role="option"
              aria-selected={selected.has(d.key)}
              data-testid={testId ? `${testId}-bar` : undefined}
              data-key={d.key}
            >
              {d.label}: {d.value === null ? 'no value' : formatValue(d.value)}
              {d.segments && series ? ` (${d.segments.map((s) => `${series[s.series]?.label ?? ''} ${s.value === null ? 'no value' : formatValue(s.value)}`).join(', ')})` : ''}
            </div>
          ))}
        </div>
      </div>
      {series && series.length > 0 && colors && <SeriesLegend series={series} colors={colors} label={colorLabel} />}
      {hover && hovered && (
        <Tooltip anchor={{ x: hover.point.x + canvasLeft, y: hover.point.y + canvasTop }} title={hovered.label} rows={tooltipRows} />
      )}
    </div>
  );
}

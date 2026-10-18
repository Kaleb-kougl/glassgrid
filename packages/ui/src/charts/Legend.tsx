import { rampValue, type RampTransform } from './colors.js';
import { formatAggregate } from './format.js';
import type { ChartSeries } from './types.js';

export interface SeriesLegendProps {
  series: readonly ChartSeries[];
  colors: readonly string[];
  /** Name of the colour field. */
  label?: string;
}

/** Colour key for series: swatch plus label (the label carries the meaning; Other is neutral). */
export function SeriesLegend({ series, colors, label }: SeriesLegendProps) {
  if (series.length === 0) return null;
  return (
    <ul className="gg-chart-legend" aria-label={label ? `Colour: ${label}` : 'Colour key'}>
      {series.map((s) => (
        <li key={s.key} className="gg-chart-legend__item" data-other={s.isOther || undefined}>
          <span className="gg-chart-legend__swatch" style={{ background: colors[s.index] }} aria-hidden="true" />
          <span className={s.isNull ? 'gg-chart-legend__label gg-chart-legend__label--null' : 'gg-chart-legend__label'}>{s.label}</span>
        </li>
      ))}
    </ul>
  );
}

export interface RampLegendProps {
  /** Sequential ramp stops. */
  ramp: readonly string[];
  /** Largest count (the ramp's top). */
  max: number;
  transform: RampTransform;
  label: string;
  formatValue?: (value: number) => string;
}

/** Heatmap key: the sequential ramp with its range, and a midpoint under the ramp's transform. */
export function RampLegend({ ramp, max, transform, label, formatValue = formatAggregate }: RampLegendProps) {
  const mid = rampValue(0.5, max, transform);
  const round = (v: number) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
  return (
    <div className="gg-chart-legend gg-chart-legend--ramp" role="group" aria-label={`${label}: 0 to ${formatValue(max)}`}>
      <span className="gg-chart-legend__label">{label}</span>
      <span className="gg-chart-legend__ramp" style={{ background: `linear-gradient(to right, ${ramp.join(', ')})` }} aria-hidden="true" />
      <span className="gg-chart-legend__ticks" aria-hidden="true">
        <span>0</span>
        <span>{formatValue(round(mid))}</span>
        <span>{formatValue(max)}</span>
      </span>
    </div>
  );
}

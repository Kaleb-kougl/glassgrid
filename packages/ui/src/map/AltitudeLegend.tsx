import type { ReactElement } from 'react';
import type { ThemeName } from '../tokens.js';
import { altitudeLegend } from './altitude.js';

/*
 * The map's colour key: the altitude bands (high first), ground traffic and
 * unknown altitude, each with the shape the map draws. Plain DOM and SVG, no
 * MapLibre, so it can render before the map chunk has loaded.
 */

const PLANE = 'M12 2.6c.7 0 1.2.6 1.2 1.4v5.3l7.8 4.2v2l-7.8-2.2v4.3l2.3 1.7v1.6L12 20l-3.5.9v-1.6l2.3-1.7v-4.3L3 15.5v-2l7.8-4.2V4c0-.8.5-1.4 1.2-1.4z';

export interface AltitudeLegendProps {
  readonly theme: ThemeName;
  readonly className?: string;
  /** Accessible name of the list (default "Aircraft altitude"). */
  readonly label?: string;
}

export function AltitudeLegend({ theme, className, label = 'Aircraft altitude' }: AltitudeLegendProps): ReactElement {
  return (
    <ul className={className ? `gg-map-legend ${className}` : 'gg-map-legend'} aria-label={label}>
      {altitudeLegend(theme).map((entry) => (
        <li key={entry.key} className="gg-map-legend__item">
          <svg className="gg-map-legend__swatch" viewBox="0 0 24 24" aria-hidden="true">
            {entry.shape === 'ring' ? (
              <circle cx="12" cy="12" r="6" fill="none" stroke={entry.color} strokeWidth="4" />
            ) : (
              <path d={PLANE} fill={entry.color} stroke="currentColor" strokeWidth="0.8" />
            )}
          </svg>
          {entry.label}
        </li>
      ))}
    </ul>
  );
}

import type { MapAircraftRow } from '@glassgrid/core';
import { Button } from '@glassgrid/ui';
import { formatAge, formatUtcTime } from '../time-format';

/*
 * The selected aircraft's details (milestone L4, docs/live-flights-l4.md):
 * callsign, type, registration, altitude, ground speed, vertical rate and
 * when it was last seen relative to T, as a description list in a strip
 * under the map (so it never hides the aircraft). A labelled region (so
 * screen readers can find it), with a button that clears the selection (as
 * Escape on the map does). The selection itself is announced by the card's
 * polite live region.
 */

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

/** The name an aircraft goes by: its callsign, else its registration, else its hex id. */
export function aircraftName(aircraft: Pick<MapAircraftRow, 'flight' | 'registration' | 'hex'>): string {
  return aircraft.flight?.trim() || aircraft.registration?.trim() || aircraft.hex;
}

export function altitudeText(aircraft: Pick<MapAircraftRow, 'altBaroFt' | 'altGeomFt' | 'onGround'>): string {
  if (aircraft.onGround) return 'On the ground';
  const ft = aircraft.altBaroFt ?? aircraft.altGeomFt;
  if (ft === null) return 'Unknown';
  return `${integer.format(ft)} ft${aircraft.altBaroFt === null ? ' (GNSS)' : ''}`;
}

export function verticalRateText(fpm: number | null): string {
  if (fpm === null) return 'Unknown';
  if (Math.abs(fpm) < 100) return `Level (${integer.format(fpm)} ft/min)`;
  return `${fpm > 0 ? 'Climbing' : 'Descending'} ${integer.format(Math.abs(fpm))} ft/min`;
}

export interface AircraftDetailsProps {
  aircraft: MapAircraftRow;
  /** T, for "last seen 12 s earlier". */
  atMs: number;
  /** Points in its track up to T, once loaded (null while loading). */
  trackPoints: number | null;
  onClose: () => void;
  testId: string;
}

export function AircraftDetails({ aircraft, atMs, trackPoints, onClose, testId }: AircraftDetailsProps) {
  const name = aircraftName(aircraft);
  const rows: [string, string][] = [
    ['Callsign', aircraft.flight?.trim() || '–'],
    ['Type', aircraft.typeCode ?? '–'],
    ['Registration', aircraft.registration ?? '–'],
    ['Altitude', altitudeText(aircraft)],
    ['Speed', aircraft.gsKt === null ? 'Unknown' : `${oneDecimal.format(aircraft.gsKt)} kt`],
    ['Vertical rate', verticalRateText(aircraft.baroRateFpm)],
    ['Last seen', `${formatUtcTime(aircraft.ts)} UTC, ${formatAge(aircraft.ts, atMs)}`],
  ];
  return (
    <section className="map-card__details" aria-label={`Selected aircraft ${name}`} data-testid={testId} data-hex={aircraft.hex}>
      <header className="map-card__details-head">
        <h4 className="map-card__details-title">{name}</h4>
        <span className="map-card__details-hex">{aircraft.hex}</span>
        <span className="panel__spacer" />
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={`Clear the selection of ${name}`} data-testid={`${testId}-close`}>
          ×
        </Button>
      </header>
      <dl className="map-card__details-list">
        {rows.map(([term, value]) => (
          <div key={term} className="map-card__details-row">
            <dt>{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div className="map-card__details-row">
          <dt>Track</dt>
          <dd data-testid={`${testId}-track`}>{trackPoints === null ? 'Loading…' : `${integer.format(trackPoints)} ${trackPoints === 1 ? 'point' : 'points'} to this time`}</dd>
        </div>
      </dl>
    </section>
  );
}

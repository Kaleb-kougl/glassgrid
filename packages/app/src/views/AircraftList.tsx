import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { MapAircraftRow, MapViewportBounds } from '@glassgrid/core';
import { altitudeText } from './AircraftDetails';

/*
 * The map's aircraft as a table (milestone L5, docs/live-flights.md): the
 * screen-reader mirror of what the map draws, and for sighted keyboard
 * users a "List view" they can show. Like the grid's ARIA mirror
 * (`packages/ui/src/grid/CanvasGrid.tsx`): a `role="grid"` with a roving
 * tab stop, arrow keys between cells, `aria-rowcount`, `aria-selected` on
 * rows, and visually hidden by default. Unlike it, it lists every aircraft
 * in view (at most a few hundred: the Bay Area peaks at 183).
 *
 * - **Rows.** The aircraft of the map's latest snapshot (after every
 *   filter) whose latest fix is inside the map's viewport (the box it last
 *   reported), sorted by callsign, then hex: a stable order, so rows do not
 *   jump as positions update.
 * - **Selection.** Enter, Space or a click selects the row's aircraft, which
 *   is the map's selection (one for the app); a selection made on the map
 *   marks its row (`aria-selected`). Escape clears it, as on the map.
 * - **Not live.** The table has no `aria-live`: its rows change every
 *   second while the cursor plays. Only the count is announced, by a polite
 *   status, at most once per COUNT_ANNOUNCE_MS, and only while focus is in
 *   the list.
 * - **Hidden, but never invisible when focused.** Hidden, it is out of
 *   sight (`.map-list--hidden`) yet in the accessibility tree and the tab
 *   order; when focus enters it (Tab from the map), it shows, so a sighted
 *   keyboard user never has an invisible focus.
 */

/** The count is announced at most this often (and only when it changed). */
export const COUNT_ANNOUNCE_MS = 10_000;

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const AIRCRAFT_COLUMNS = ['Callsign', 'Type', 'Altitude', 'Ground speed', 'Heading', 'Vertical rate'] as const;

/** The aircraft whose latest fix is inside `bounds` (all of them before the map reported a viewport). */
export function aircraftInView(aircraft: readonly MapAircraftRow[], bounds: MapViewportBounds | undefined): MapAircraftRow[] {
  if (bounds === undefined) return [...aircraft];
  return aircraft.filter((a) => a.lat >= bounds.south && a.lat <= bounds.north && a.lon >= bounds.west && a.lon <= bounds.east);
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** By callsign (aircraft without one last), then hex. */
export function sortAircraft(aircraft: readonly MapAircraftRow[]): MapAircraftRow[] {
  return [...aircraft].sort((a, b) => {
    const ca = a.flight?.trim() ?? '';
    const cb = b.flight?.trim() ?? '';
    if (ca === '' !== (cb === '')) return ca === '' ? 1 : -1;
    return collator.compare(ca, cb) || (a.hex < b.hex ? -1 : a.hex > b.hex ? 1 : 0);
  });
}

export function verticalRateCell(fpm: number | null): string {
  if (fpm === null) return 'Unknown';
  if (Math.abs(fpm) < 100) return 'Level';
  return `${fpm > 0 ? '+' : '−'}${integer.format(Math.abs(fpm))} ft/min`;
}

/** The six cells of a row, as text. */
export function aircraftCells(a: MapAircraftRow): [string, string, string, string, string, string] {
  return [
    a.flight?.trim() || `None (${a.hex})`,
    a.typeCode ?? '–',
    altitudeText(a),
    a.gsKt === null ? 'Unknown' : `${integer.format(a.gsKt)} kt`,
    a.trackDeg === null ? '–' : `${integer.format(Math.round(a.trackDeg) % 360)}°`,
    verticalRateCell(a.baroRateFpm),
  ];
}

export interface AircraftListProps {
  /** The map's aircraft in view (unsorted). */
  aircraft: readonly MapAircraftRow[];
  selectedHex: string | null;
  onSelect: (hex: string | null) => void;
  /** Shown ("List view" on) or visually hidden (still in the tab order; shown while focused). */
  visible: boolean;
  /** The map's title, for the table's name. */
  title: string;
  id: string;
  testId: string;
}

const PAGE_ROWS = 10;

export function AircraftList({ aircraft, selectedHex, onSelect, visible, title, id, testId }: AircraftListProps) {
  const rows = useMemo(() => sortAircraft(aircraft), [aircraft]);
  const columns = AIRCRAFT_COLUMNS.length;
  /** The focused cell, by aircraft (rows move as the list changes) and column. */
  const [focus, setFocus] = useState<{ hex: string; col: number } | null>(null);
  const [focusWithin, setFocusWithin] = useState(false);
  const focusPending = useRef(false);
  /** Focus is in the list, as far as the list knows: a focused row that went away (its aircraft left the view) does not count as leaving. */
  const inList = useRef(false);
  const root = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  let focusRow = focus === null ? -1 : rows.findIndex((row) => row.hex === focus.hex);
  // A focused aircraft that left the view: the tab stop stays at its place in the list.
  const [lastRow, setLastRow] = useState(0);
  if (focusRow < 0 && rows.length > 0) focusRow = Math.min(lastRow, rows.length - 1);
  if (focusRow >= 0 && focusRow !== lastRow) setLastRow(focusRow);
  const focusCol = focus?.col ?? 0;

  const move = (row: number, col: number) => {
    const target = rows[Math.max(0, Math.min(rows.length - 1, row))];
    if (!target) return;
    focusPending.current = true;
    setFocus({ hex: target.hex, col: Math.max(0, Math.min(columns - 1, col)) });
  };

  // Focus follows the roving tab stop while focus is in the list ...
  useLayoutEffect(() => {
    const hex = rows[focusRow]?.hex;
    if (focusPending.current) {
      focusPending.current = false;
      if (hex !== undefined) document.getElementById(`${id}-${hex}-${focusCol}`)?.focus();
      return;
    }
    // ... and when the focused row's aircraft left the view, its row went with the focus: focus the cell now at its
    // place (the same column, the row clamped to the list), before the browser paints the page without it.
    const active = document.activeElement;
    if (!inList.current || root.current === null) return;
    if (active !== null && active !== document.body) return; // focus is in the list, or went somewhere on purpose
    if (hex === undefined) {
      inList.current = false;
      return;
    }
    // The cell's onFocus makes it the tab stop.
    document.getElementById(`${id}-${hex}-${focusCol}`)?.focus();
  });

  // A selection made elsewhere (the map) scrolls its row into the shown list, within the list only.
  useEffect(() => {
    const box = scroller.current;
    if (!visible || box === null || selectedHex === null) return;
    const row = [...box.querySelectorAll<HTMLElement>('tr[data-hex]')].find((candidate) => candidate.dataset['hex'] === selectedHex);
    if (!row) return;
    const top = row.offsetTop - (box.querySelector('thead')?.offsetHeight ?? 0);
    if (top < box.scrollTop) box.scrollTop = top;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight;
  }, [visible, selectedHex]);

  // The count, politely, at most once per COUNT_ANNOUNCE_MS and only while focus is in the list.
  const [announced, setAnnounced] = useState('');
  const announcedAt = useRef(0);
  const countText = `${integer.format(rows.length)} aircraft in view`;
  useEffect(() => {
    if (!focusWithin || countText === announced) return;
    const timer = setTimeout(
      () => {
        announcedAt.current = Date.now();
        setAnnounced(countText);
      },
      Math.max(0, announcedAt.current + COUNT_ANNOUNCE_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [focusWithin, countText, announced]);

  const onKeyDown = (event: KeyboardEvent<HTMLTableElement>) => {
    if (rows.length === 0) return;
    const row = Math.max(0, focusRow);
    const ctrl = event.ctrlKey || event.metaKey;
    switch (event.key) {
      case 'ArrowDown':
        move(row + 1, focusCol);
        break;
      case 'ArrowUp':
        move(row - 1, focusCol);
        break;
      case 'ArrowRight':
        move(row, focusCol + 1);
        break;
      case 'ArrowLeft':
        move(row, focusCol - 1);
        break;
      case 'PageDown':
        move(row + PAGE_ROWS, focusCol);
        break;
      case 'PageUp':
        move(row - PAGE_ROWS, focusCol);
        break;
      case 'Home':
        move(ctrl ? 0 : row, 0);
        break;
      case 'End':
        move(ctrl ? rows.length - 1 : row, columns - 1);
        break;
      case 'Enter':
      case ' ': {
        const hex = rows[row]?.hex;
        if (hex !== undefined) onSelect(hex);
        break;
      }
      case 'Escape':
        if (selectedHex === null) return;
        onSelect(null);
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      className={visible ? 'map-list' : 'map-list map-list--hidden'}
      data-testid={testId}
      data-visible={visible ? 'true' : 'false'}
      ref={root}
      onFocus={() => {
        inList.current = true;
        setFocusWithin(true);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next !== null) {
          if (!event.currentTarget.contains(next)) {
            inList.current = false;
            setFocusWithin(false);
          }
          return;
        }
        // Focus to nowhere: a click on the page, another window, or the focused row removed. Only the first two leave.
        const left = event.target;
        setTimeout(() => {
          if (left.isConnected && !(root.current?.contains(document.activeElement) ?? false)) {
            inList.current = false;
            setFocusWithin(false);
          }
        }, 0);
      }}
    >
      <div className="map-list__scroller gg-scroll" ref={scroller}>
        <table
          id={id}
          className="map-list__table"
          role="grid"
          aria-label={`Aircraft in view: ${title}`}
          aria-rowcount={rows.length + 1}
          aria-describedby={`${id}-caption`}
          onKeyDown={onKeyDown}
        >
          <caption id={`${id}-caption`} className="map-list__caption">
            {rows.length === 0 ? 'No aircraft in view' : `${countText}, by callsign. Enter selects one on the map.`}
          </caption>
          <thead>
            <tr aria-rowindex={1}>
              {AIRCRAFT_COLUMNS.map((name, col) => (
                <th key={name} scope="col" role="columnheader" aria-sort={col === 0 ? 'ascending' : undefined}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((a, index) => {
              const selected = a.hex === selectedHex;
              return (
                <tr key={a.hex} aria-rowindex={index + 2} aria-selected={selected} data-hex={a.hex} className={selected ? 'map-list__row map-list__row--selected' : 'map-list__row'}>
                  {aircraftCells(a).map((text, col) => (
                    <td
                      key={col}
                      id={`${id}-${a.hex}-${col}`}
                      role="gridcell"
                      tabIndex={index === focusRow && col === focusCol ? 0 : -1}
                      onFocus={() => {
                        if (focus?.hex !== a.hex || focus.col !== col) setFocus({ hex: a.hex, col });
                      }}
                      onClick={() => {
                        setFocus({ hex: a.hex, col });
                        onSelect(a.hex);
                      }}
                    >
                      {text}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <span className="gg-visually-hidden" role="status" data-testid={`${testId}-count`}>
        {announced}
      </span>
    </div>
  );
}

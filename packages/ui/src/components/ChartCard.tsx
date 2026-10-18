import { useEffect, useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { cx } from '../cx.js';
import { Button } from './Button.js';
import { draggedColumn, isColumnDrag } from './ColumnListRow.js';
import { Menu, useMenuState, type MenuEntry } from './Menu.js';

/** True once `active` has stayed true for `delayMs` (the 300 ms loading rule). */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    // Both updates run from timers: `shown` only matters while `active`.
    const timer = active ? setTimeout(() => setShown(true), delayMs) : setTimeout(() => setShown(false), 0);
    return () => clearTimeout(timer);
  }, [active, delayMs]);
  return active && shown;
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  testId?: string;
}

/** A labelled on/off switch (`role="switch"`), e.g. "View data". */
export function Switch({ checked, onChange, label, testId }: SwitchProps) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="gg-switch" onClick={() => onChange(!checked)} data-testid={testId}>
      <span className="gg-switch__track" aria-hidden="true">
        <span className="gg-switch__knob" />
      </span>
      <span>{label}</span>
    </button>
  );
}

export interface ChartSkeletonProps {
  /** [label width, bar width] pairs as CSS lengths. */
  rows?: readonly (readonly [string, string])[];
}

const SKELETON_ROWS = [
  ['60%', '74%'],
  ['40%', '22%'],
  ['56%', '12%'],
  ['48%', '6%'],
  ['36%', '4%'],
] as const;

/** Placeholder bars while a slow aggregate runs. */
export function ChartSkeleton({ rows = SKELETON_ROWS }: ChartSkeletonProps) {
  return (
    <div className="gg-chart-skeleton" aria-hidden="true">
      {rows.map(([label, bar], i) => (
        <div className="gg-chart-skeleton__row" key={i}>
          <div className="gg-chart-skeleton__label">
            <span style={{ width: label }} />
          </div>
          <div className="gg-chart-skeleton__bar">
            <span style={{ width: bar }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export interface ChartCardError {
  /** Bold first line; defaults to "This chart could not be computed". */
  title?: string;
  /** The engine's or compiler's message, shown verbatim. */
  message: string;
  /** Optional mono detail line (e.g. the offending input path or source line). */
  detail?: string;
  actions?: ReactNode;
}

export interface ChartCardProps {
  title: string;
  /**
   * Read after the title in the card's accessible name (visually hidden),
   * e.g. "Line chart, 2 of 4": keeps cards with equal titles distinguishable.
   */
  description?: string;
  /** Called with a trimmed, non-empty title when an edit is committed. */
  onRename?: (title: string) => void;
  /** Quiet attribution next to the title, as in History. */
  attribution?: 'ai';
  /** Summary of this card's own selection ("1 selected") with a Clear action. */
  selection?: { summary: string; onClear: () => void };
  /** Items of the ⋯ menu. */
  menu?: readonly MenuEntry[];
  /** The shelves row (ShelfChips). */
  shelves?: ReactNode;
  status?: 'ready' | 'loading' | 'error';
  error?: ChartCardError;
  /** How long a load may take before the skeleton shows. Default 300 ms (`--gg-loading-delay`). */
  loadingDelayMs?: number;
  /** "View data": the aggregate rows as a table instead of the chart. */
  viewData?: { on: boolean; onToggle: (on: boolean) => void; table: ReactNode };
  /** Footer count, e.g. "5 rows". */
  rowsLabel?: string;
  /** Accepts a column dropped anywhere on the card. */
  onDropColumn?: (column: string) => void;
  children?: ReactNode;
  testId?: string;
}

/**
 * Chart card chrome: editable title, selection summary, ⋯ menu, shelves,
 * body (chart, skeleton after 300 ms, or the engine's error) and the
 * "View data" footer.
 */
export function ChartCard({
  title,
  description,
  onRename,
  attribution,
  selection,
  menu,
  shelves,
  status = 'ready',
  error,
  loadingDelayMs = 300,
  viewData,
  rowsLabel,
  onDropColumn,
  children,
  testId,
}: ChartCardProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [over, setOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleButtonRef = useRef<HTMLButtonElement>(null);
  const menuState = useMenuState();
  const slow = useDelayedFlag(status === 'loading', loadingDelayMs);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const startEditing = () => {
    if (!onRename) return;
    setDraft(title);
    setEditing(true);
  };
  const finishEditing = (commit: boolean) => {
    setEditing(false);
    const next = draft.trim();
    if (commit && next !== '' && next !== title) onRename?.(next);
    requestAnimationFrame(() => titleButtonRef.current?.focus());
  };

  const menuItems: MenuEntry[] = [
    ...(onRename ? [{ id: 'rename', label: 'Rename…', onSelect: startEditing } satisfies MenuEntry] : []),
    ...(menu ?? []),
  ];

  const dropHandlers = onDropColumn
    ? {
        onDragOver: (event: DragEvent) => {
          if (!isColumnDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          setOver(true);
        },
        onDragLeave: (event: DragEvent) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver(false);
        },
        onDrop: (event: DragEvent) => {
          setOver(false);
          const column = draggedColumn(event.dataTransfer);
          if (column === null) return;
          event.preventDefault();
          event.stopPropagation();
          onDropColumn(column);
        },
      }
    : {};

  let body: ReactNode;
  if (status === 'error') {
    body = (
      <div className="gg-chart-error" role="alert" data-testid={testId ? `${testId}-error` : undefined}>
        <span className="gg-chart-error__icon" aria-hidden="true">
          !
        </span>
        <div className="gg-chart-error__text">
          <span className="gg-chart-error__title">{error?.title ?? 'This chart could not be computed'}</span>
          <span className="gg-chart-error__message">{error?.message ?? 'Unknown error'}</span>
          {error?.detail !== undefined && <span className="gg-chart-error__detail">{error.detail}</span>}
          {error?.actions !== undefined && <div className="gg-chart-error__actions">{error.actions}</div>}
        </div>
      </div>
    );
  } else if (slow) {
    body = <ChartSkeleton />;
  } else if (viewData?.on) {
    // Scrolls when long: a focusable, named region so keyboard users can scroll it.
    body = (
      <div className="gg-chart-data" role="region" tabIndex={0} aria-label={`${title}${description ? ` (${description})` : ''}: data`}>
        {viewData.table}
      </div>
    );
  } else {
    body = children;
  }

  return (
    <section
      className={cx('gg-chart-card', over && 'gg-chart-card--drop-target')}
      aria-labelledby={description ? `${titleId} ${descriptionId}` : titleId}
      aria-busy={status === 'loading'}
      data-testid={testId}
      data-status={slow ? 'loading' : status}
      {...dropHandlers}
    >
      {description && (
        <span id={descriptionId} className="gg-visually-hidden">
          {description}
        </span>
      )}
      <header className="gg-chart-card__header">
        {editing ? (
          <input
            ref={inputRef}
            id={titleId}
            className="gg-chart-card__title-input"
            aria-label="Chart title"
            value={draft}
            maxLength={200}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => finishEditing(true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') finishEditing(true);
              if (event.key === 'Escape') {
                event.stopPropagation();
                finishEditing(false);
              }
            }}
          />
        ) : (
          <h3 className="gg-chart-card__title" id={titleId}>
            {onRename ? (
              <button
                ref={titleButtonRef}
                type="button"
                className="gg-chart-card__title-button"
                title="Rename"
                onClick={startEditing}
              >
                {title}
              </button>
            ) : (
              title
            )}
          </h3>
        )}
        {!editing && attribution === 'ai' && <span className="gg-attribution">by AI</span>}
        {!editing && <span className="gg-chart-card__spacer" />}
        {status === 'loading' && slow && <span className="gg-chart-card__status">Updating…</span>}
        {status !== 'loading' && selection && (
          <>
            <span className="gg-chart-card__status">{selection.summary}</span>
            <Button variant="ghost" className="gg-chart-card__clear" onClick={selection.onClear}>
              Clear
            </Button>
          </>
        )}
        {menuItems.length > 0 && (
          <>
            <Button {...menuState.triggerProps} variant="icon" label="Chart actions" className="gg-chart-card__menu">
              ⋯
            </Button>
            <Menu
              id={menuState.menuId}
              anchorRef={menuState.triggerRef}
              open={menuState.open}
              onClose={menuState.close}
              items={menuItems}
              label="Chart actions"
              placement="bottom-end"
            />
          </>
        )}
      </header>
      {shelves}
      <div className="gg-chart-card__body">{body}</div>
      <footer className="gg-chart-card__footer">
        {viewData && <Switch checked={viewData.on} onChange={viewData.onToggle} label="View data" testId={testId ? `${testId}-view-data` : undefined} />}
        <span className="gg-chart-card__spacer" />
        {rowsLabel !== undefined && <span className="gg-chart-card__rows">{rowsLabel}</span>}
      </footer>
    </section>
  );
}

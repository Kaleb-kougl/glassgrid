import { useState, type DragEvent, type KeyboardEvent } from 'react';
import { cx } from '../cx.js';
import { draggedColumn, isColumnDrag } from './ColumnListRow.js';
import { Menu, useMenuState, type MenuEntry } from './Menu.js';

export interface ShelfChipProps {
  /** Shelf name: X, Y or Color. */
  shelf: string;
  /**
   * The field expression, e.g. `payment_type` or `sum(fare_amount)`. The
   * aggregate is part of the Y value; there is no separate aggregate shelf.
   * Omitted: an empty shelf that invites a drop.
   */
  value?: string;
  /** Who put the field there; `ai` adds a quiet "AI" label, as in History. */
  addedBy?: 'user' | 'ai';
  /** Accepts a dragged column. */
  onDropColumn?: (column: string) => void;
  /** Name of the column being dragged right now (known to the app), for the "add …" hint. */
  pendingColumn?: string | null;
  /** Choices behind the chip's caret, e.g. the Y aggregate. */
  menu?: readonly MenuEntry[];
  menuLabel?: string;
  /** Clears the shelf (×, or Backspace/Delete on the focused chip). */
  onRemove?: () => void;
  /** Tooltip, e.g. why an empty shelf does not accept drops yet. */
  title?: string;
  testId?: string;
}

/**
 * One shelf of a chart card. Filled chips show the field in mono; empty ones
 * are dashed drop targets; while a column is dragged over, the chip turns
 * into an accent drop target.
 */
export function ShelfChip({
  shelf,
  value,
  addedBy = 'user',
  onDropColumn,
  pendingColumn,
  menu,
  menuLabel,
  onRemove,
  title,
  testId,
}: ShelfChipProps) {
  const [over, setOver] = useState(false);
  const menuState = useMenuState();
  const empty = value === undefined;

  const dropHandlers = onDropColumn
    ? {
        onDragOver: (event: DragEvent) => {
          if (!isColumnDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = 'copy';
          setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (event: DragEvent) => {
          const column = draggedColumn(event.dataTransfer);
          setOver(false);
          if (column === null) return;
          event.preventDefault();
          event.stopPropagation();
          onDropColumn(column);
        },
      }
    : {};

  const classes = cx('gg-shelf-chip', empty && 'gg-shelf-chip--empty', over && 'gg-shelf-chip--drop-target');
  const content = empty ? (
    <>
      <span className="gg-shelf-chip__shelf">{shelf}</span>
      <span className="gg-shelf-chip__value">{over && pendingColumn ? `add ${pendingColumn}` : 'drop a column'}</span>
    </>
  ) : (
    <>
      <span className="gg-shelf-chip__shelf">{shelf}</span>
      <span className="gg-shelf-chip__value">{over && pendingColumn ? `replace with ${pendingColumn}` : value}</span>
      {addedBy === 'ai' && (
        <span className="gg-shelf-chip__by" title="Added by AI">
          AI
        </span>
      )}
      {menu && (
        <span className="gg-shelf-chip__caret" aria-hidden="true">
          ▾
        </span>
      )}
    </>
  );
  const accessibleName = empty
    ? `${shelf} shelf, empty.${onDropColumn ? ' Drop a column here.' : ''}`
    : `${shelf}: ${value}${addedBy === 'ai' ? ', added by AI' : ''}`;
  const onKeyDown = onRemove
    ? (event: KeyboardEvent) => {
        if (!empty && (event.key === 'Backspace' || event.key === 'Delete')) {
          event.preventDefault();
          onRemove();
        }
      }
    : undefined;

  const chip =
    menu && !empty ? (
      <>
        <button
          type="button"
          {...menuState.triggerProps}
          onKeyDown={(event) => {
            menuState.triggerProps.onKeyDown(event);
            onKeyDown?.(event);
          }}
          className={classes}
          aria-label={accessibleName}
          data-testid={testId}
          {...dropHandlers}
        >
          {content}
        </button>
        <Menu
          id={menuState.menuId}
          anchorRef={menuState.triggerRef}
          open={menuState.open}
          onClose={menuState.close}
          items={menu}
          label={menuLabel ?? `${shelf} shelf`}
        />
      </>
    ) : (
      <div
        className={classes}
        role="group"
        tabIndex={empty ? undefined : 0}
        aria-label={title ? `${accessibleName} ${title}` : accessibleName}
        title={title}
        data-testid={testId}
        onKeyDown={onKeyDown}
        {...dropHandlers}
      >
        {content}
      </div>
    );

  if (!onRemove || empty) return chip;
  return (
    <div className="gg-shelf-chip-wrap">
      {chip}
      <button
        type="button"
        className="gg-shelf-chip__remove"
        aria-label={`Remove ${value} from ${shelf}`}
        title="Remove"
        onClick={onRemove}
        style={{ position: 'absolute', right: 4, top: 3 }}
      >
        ×
      </button>
    </div>
  );
}

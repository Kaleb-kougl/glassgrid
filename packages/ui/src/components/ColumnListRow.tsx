import { useState, type ReactNode } from 'react';
import type { ColumnType } from '@glassgrid/core';
import { cx } from '../cx.js';
import { ProgressBar } from './ProgressIndicator.js';
import { TypeMenu } from './TypeMenu.js';

/** DataTransfer type carrying a column name while it is dragged. */
export const COLUMN_DRAG_TYPE = 'application/x-glassgrid-column';

/** The dragged column's name, if a drag carries one. */
export function draggedColumn(dataTransfer: DataTransfer | null): string | null {
  if (!dataTransfer) return null;
  const name = dataTransfer.getData(COLUMN_DRAG_TYPE);
  return name === '' ? null : name;
}

/** True while a drag carries a column (its name is unreadable until drop). */
export function isColumnDrag(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer?.types.includes(COLUMN_DRAG_TYPE));
}

export interface ColumnListRowProps {
  name: string;
  type: ColumnType;
  inferredType: ColumnType;
  /** Distinct-value count, already formatted; null while unknown. */
  distinct: ReactNode;
  /** The profile for this column is still running. */
  profiling?: boolean;
  /** The column is part of the grid selection. */
  selected?: boolean;
  onTypeChange: (type: ColumnType) => void;
  /** Enter on the focused row: the keyboard path for "drag onto the charts". */
  onActivate?: () => void;
  testId?: string;
}

/**
 * One row of the Columns panel: type badge (opens the type menu), name and
 * distinct count. Rows drag onto the chart canvas or a shelf; Enter does the
 * same for keyboard users.
 */
export function ColumnListRow({
  name,
  type,
  inferredType,
  distinct,
  profiling = false,
  selected = false,
  onTypeChange,
  onActivate,
  testId,
}: ColumnListRowProps) {
  const [dragging, setDragging] = useState(false);
  return (
    <li
      className={cx('gg-column-row', dragging && 'gg-column-row--dragging')}
      data-selected={selected}
      data-testid={testId}
      tabIndex={0}
      draggable
      aria-label={`${name}, ${type}${selected ? ', in the grid selection' : ''}. Press Enter to chart it, or drag it onto the charts.`}
      onDragStart={(event) => {
        event.dataTransfer.setData(COLUMN_DRAG_TYPE, name);
        event.dataTransfer.setData('text/plain', name);
        event.dataTransfer.effectAllowed = 'copy';
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && event.key === 'Enter' && onActivate) {
          event.preventDefault();
          onActivate();
        }
      }}
    >
      <TypeMenu column={name} type={type} inferredType={inferredType} onChange={onTypeChange} testId={testId ? `${testId}-type` : undefined} />
      <span className="gg-column-row__name">{name}</span>
      {profiling && <ProgressBar variant="mini" value={null} label={`Profiling ${name}`} />}
      <span className="gg-column-row__distinct">{profiling ? '' : distinct}</span>
    </li>
  );
}

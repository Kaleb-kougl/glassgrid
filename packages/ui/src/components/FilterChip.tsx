import { cx } from '../cx.js';

export interface FilterChipProps {
  /** Column the filter applies to (shown in mono). */
  column: string;
  /** The condition in words, e.g. `= Cash` or `2.00 – 6.00`. */
  condition: string;
  onRemove: () => void;
  /** Who set it, for the tooltip. */
  addedBy?: 'user' | 'ai';
  /**
   * A short label shown instead of the column and condition (a map's
   * viewport: `Map view`); both stay in the accessible name and the
   * tooltip.
   */
  shortLabel?: string;
  className?: string;
  testId?: string;
}

/**
 * An active filter above the grid. Always names the column and the condition
 * in words (a long condition is cut with an ellipsis; the tooltip has it
 * whole). × or Backspace/Delete on the focused chip removes it.
 */
export function FilterChip({ column, condition, onRemove, addedBy, shortLabel, className, testId }: FilterChipProps) {
  const name = `Filter ${column} ${condition}`;
  return (
    <div
      className={cx('gg-filter-chip', className)}
      role="group"
      tabIndex={0}
      aria-label={name}
      title={addedBy === 'ai' ? `${name} (set by AI)` : `${column} ${condition}`}
      data-testid={testId}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Backspace' || event.key === 'Delete')) {
          event.preventDefault();
          onRemove();
        }
      }}
    >
      {shortLabel !== undefined ? (
        <span className="gg-filter-chip__column">{shortLabel}</span>
      ) : (
        <>
          <span className="gg-filter-chip__column">{column}</span>
          <span className="gg-filter-chip__condition">{condition}</span>
        </>
      )}
      <button type="button" className="gg-filter-chip__remove" aria-label={`Remove filter on ${column}`} title="Remove filter" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

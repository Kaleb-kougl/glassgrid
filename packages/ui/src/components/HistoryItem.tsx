import { cx } from '../cx.js';

export type HistoryItemState = 'current' | 'applied' | 'undone';

export interface HistoryItemProps {
  label: string;
  caller: 'user' | 'ai';
  /** Pre-formatted time, e.g. `14:32`. */
  time?: string;
  /**
   * - `current`: the latest applied change (filled dot);
   * - `applied`: an earlier change;
   * - `undone`: after the current one, struck through, can be redone.
   */
  state: HistoryItemState;
  /** Makes the item a button, e.g. "step back/forward to here". */
  onSelect?: () => void;
  testId?: string;
}

/** Caller attribution as the history and toasts word it. */
export function callerLabel(caller: 'user' | 'ai'): string {
  return caller === 'ai' ? 'by AI' : 'by you';
}

/** One entry of the History list with its caller ("by you" / "by AI"). */
export function HistoryItem({ label, caller, time, state, onSelect, testId }: HistoryItemProps) {
  const meta = time === undefined ? callerLabel(caller) : `${callerLabel(caller)} · ${time}`;
  const body = (
    <>
      <span className="gg-history-item__dot" aria-hidden="true" />
      <span className="gg-history-item__text">
        <span className="gg-history-item__label">{label}</span>
        <span className="gg-history-item__meta" data-testid={testId ? `${testId}-caller` : undefined}>
          {meta}
        </span>
      </span>
    </>
  );
  const classes = cx('gg-history-item', `gg-history-item--${state}`, onSelect && 'gg-history-item--interactive');
  const stateText = state === 'current' ? ', current state' : state === 'undone' ? ', undone' : '';
  return (
    <li data-testid={testId} data-undone={state === 'undone'} data-current={state === 'current'}>
      {onSelect ? (
        <button
          type="button"
          className={classes}
          aria-current={state === 'current' ? 'step' : undefined}
          aria-label={`${label}, ${meta}${stateText}`}
          onClick={onSelect}
        >
          {body}
        </button>
      ) : (
        <div className={classes} aria-current={state === 'current' ? 'step' : undefined}>
          {body}
        </div>
      )}
    </li>
  );
}

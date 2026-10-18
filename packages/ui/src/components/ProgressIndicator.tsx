import { cx } from '../cx.js';

export interface ProgressBarProps {
  /** 0..1, or null while the amount is unknown (indeterminate). */
  value: number | null;
  /** What is progressing, e.g. "Optimizing file". Visible except on `mini`. */
  label: string;
  /**
   * - `inline`: label and percentage above a full-width 4px bar.
   * - `titlebar`: label, a 96px bar and the percentage in one line ("Optimizing file").
   * - `mini`: a 36x3px bar, e.g. per-column profiling.
   */
  variant?: 'inline' | 'titlebar' | 'mini';
  /** Tooltip, e.g. what the work is for. */
  title?: string;
  className?: string;
}

function percent(value: number): number {
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

/**
 * A progress bar. With reduced motion the indeterminate sweep stops; the
 * label and percentage carry the state.
 */
export function ProgressBar({ value, label, variant = 'inline', title, className }: ProgressBarProps) {
  const pct = value === null ? null : percent(value);
  const bar = (
    <div
      className="gg-progress__track"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-valuetext={pct === null ? `${label}…` : `${pct}%`}
    >
      <div className="gg-progress__fill" style={pct === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
  const classes = cx('gg-progress', `gg-progress--${variant}`, pct === null && 'gg-progress--indeterminate', className);
  if (variant === 'mini') {
    return (
      <div className={classes} title={title ?? label}>
        {bar}
      </div>
    );
  }
  const value_ = pct === null ? null : <span className="gg-progress__value">{pct}%</span>;
  if (variant === 'titlebar') {
    return (
      <div className={classes} title={title}>
        <span>{label}</span>
        {bar}
        {value_}
      </div>
    );
  }
  return (
    <div className={classes} title={title}>
      <div className="gg-progress__head">
        <span className="gg-progress__label">{label}</span>
        {value_}
      </div>
      {bar}
    </div>
  );
}

export interface SpinnerProps {
  /** Shown next to the ring, e.g. "Updating…". */
  label: string;
  className?: string;
}

/** Small busy ring with a text label; the ring stops under reduced motion. */
export function Spinner({ label, className }: SpinnerProps) {
  return (
    <span className={cx('gg-spinner', className)} role="status">
      <span className="gg-spinner__ring" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

import { useEffect, type ReactNode } from 'react';
import { cx } from '../cx.js';
import { Button } from './Button.js';

export interface ToastAction {
  readonly label: string;
  /** Shown after the label, e.g. `⌘Z` next to Undo. */
  readonly shortcut?: string;
  readonly onClick: () => void;
}

export interface ToastProps {
  /** `info` toasts announce politely and dismiss themselves; `error` toasts stay until dismissed. */
  tone?: 'info' | 'error';
  message: ReactNode;
  /** Quiet attribution after the message ("by AI"). */
  by?: string;
  action?: ToastAction;
  onDismiss: () => void;
  /** Auto-dismiss delay for info toasts. Default 6 s. */
  timeoutMs?: number;
  className?: string;
}

/**
 * One toast at a time, bottom-centre of the grid. Info toasts carry an Undo
 * action and leave after 6 s; error toasts stay until dismissed.
 */
export function Toast({ tone = 'info', message, by, action, onDismiss, timeoutMs = 6000, className }: ToastProps) {
  useEffect(() => {
    if (tone !== 'info') return;
    const timer = setTimeout(onDismiss, timeoutMs);
    return () => clearTimeout(timer);
  }, [tone, timeoutMs, onDismiss, message]);

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cx('gg-toast', tone === 'error' && 'gg-toast--error', className)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onDismiss();
      }}
    >
      {tone === 'error' && (
        <span className="gg-toast__icon" aria-hidden="true">
          !
        </span>
      )}
      <span className="gg-toast__message">{message}</span>
      {by !== undefined && <span className="gg-toast__by">{by}</span>}
      {action && (
        <Button
          size="sm"
          variant={tone === 'error' ? 'ghost' : 'secondary'}
          onClick={() => {
            action.onClick();
            onDismiss();
          }}
        >
          {action.label}
          {action.shortcut !== undefined && <span className="gg-button__shortcut">{action.shortcut}</span>}
        </Button>
      )}
      {tone === 'error' && (
        <Button size="sm" variant="icon" label="Dismiss" onClick={onDismiss}>
          ×
        </Button>
      )}
    </div>
  );
}

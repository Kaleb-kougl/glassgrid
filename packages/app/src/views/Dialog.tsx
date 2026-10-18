import { useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';

/*
 * A modal dialog: labelled by its title, described by its body, focus moved
 * in on open (the element with `data-autofocus`, else the first control),
 * Tab and Shift+Tab kept inside, Escape cancels, and focus returned to where
 * it was on close. The app marks the rest of the window `inert` while one is
 * open, so pointer and assistive-technology users cannot reach behind it.
 */

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];
}

export interface DialogProps {
  title: string;
  /** The explanation; read out with the title (`aria-describedby`). */
  children: ReactNode;
  /** The buttons, in reading order (the primary one last, as the design system orders them). */
  actions: ReactNode;
  /** Escape. Should do what the Cancel button does. */
  onCancel: () => void;
  /** `alertdialog` when the person must answer before going on (it interrupts what they were doing). */
  role?: 'dialog' | 'alertdialog';
  testId?: string;
}

export function Dialog({ title, children, actions, onCancel, role = 'dialog', testId }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();

  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    if (root) (root.querySelector<HTMLElement>('[data-autofocus]') ?? focusables(root)[0] ?? root).focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onCancel();
      return;
    }
    if (event.key !== 'Tab' || !ref.current) return;
    const items = focusables(ref.current);
    const first = items[0];
    const last = items.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !ref.current.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !ref.current.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div
        ref={ref}
        className="dialog"
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        data-testid={testId}
      >
        <h2 className="dialog__title" id={titleId}>
          {title}
        </h2>
        <div className="dialog__body" id={bodyId}>
          {children}
        </div>
        <div className="dialog__actions">{actions}</div>
      </div>
    </div>
  );
}

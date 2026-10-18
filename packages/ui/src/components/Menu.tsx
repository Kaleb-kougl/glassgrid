import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { cx } from '../cx.js';
import { Popover, type PopoverPlacement } from './Popover.js';

export type MenuEntry =
  | {
      readonly kind?: 'item' | 'radio';
      readonly id: string;
      readonly label: string;
      /** Short mono code before the label, e.g. a type badge. */
      readonly badge?: string;
      /** For `radio` items. */
      readonly checked?: boolean;
      readonly disabled?: boolean;
      readonly tone?: 'default' | 'muted' | 'danger';
      readonly onSelect: () => void;
    }
  | { readonly kind: 'separator'; readonly id: string };

type ActionEntry = Exclude<MenuEntry, { kind: 'separator' }>;

function isAction(entry: MenuEntry): entry is ActionEntry {
  return entry.kind !== 'separator';
}

export interface MenuProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  /** Called on Escape, Tab, an outside press or after an item is chosen. */
  onClose: (reason: 'escape' | 'select' | 'outside' | 'tab') => void;
  items: readonly MenuEntry[];
  /** Accessible name of the menu. */
  label: string;
  /** Optional context line above the items, e.g. "payment_type · inferred integer". */
  header?: ReactNode;
  placement?: PopoverPlacement;
  id?: string;
}

/**
 * A WAI-ARIA menu: arrow keys, Home/End, Enter/Space, Escape. Focus moves
 * into the menu on open (to the checked item, else the first) and back to
 * the anchor on Escape or after a choice.
 */
export function Menu({ anchorRef, open, onClose, items, label, header, placement, id }: MenuProps) {
  const listRef = useRef<HTMLDivElement>(null);

  const itemsEls = () => [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];

  useEffect(() => {
    if (!open) return;
    // Wait a frame so the portalled list exists and is positioned.
    const frame = requestAnimationFrame(() => {
      const els = itemsEls();
      const checked = els.find((el) => el.getAttribute('aria-checked') === 'true');
      (checked ?? els[0])?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const close = (reason: 'escape' | 'select' | 'outside' | 'tab') => {
    onClose(reason);
    if (reason !== 'outside' && reason !== 'tab') anchorRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const els = itemsEls();
    const index = els.indexOf(document.activeElement as HTMLButtonElement);
    const focusAt = (i: number) => els[(i + els.length) % els.length]?.focus();
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusAt(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusAt(index < 0 ? els.length - 1 : index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusAt(0);
        break;
      case 'End':
        event.preventDefault();
        focusAt(els.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close('escape');
        break;
      case 'Tab':
        close('tab');
        break;
    }
  };

  return (
    <Popover anchorRef={anchorRef} open={open} onClose={() => onClose('outside')} placement={placement}>
      <div ref={listRef} role="menu" aria-label={label} id={id} onKeyDown={onKeyDown} className="gg-menu">
        {header !== undefined && (
          <div className="gg-menu__header" role="presentation">
            {header}
          </div>
        )}
        {items.map((entry) =>
          isAction(entry) ? (
            <button
              key={entry.id}
              type="button"
              tabIndex={-1}
              role={entry.kind === 'radio' ? 'menuitemradio' : 'menuitem'}
              aria-checked={entry.kind === 'radio' ? Boolean(entry.checked) : undefined}
              disabled={entry.disabled}
              className={cx(
                'gg-menu__item',
                entry.tone === 'muted' && 'gg-menu__item--muted',
                entry.tone === 'danger' && 'gg-menu__item--danger',
              )}
              onClick={() => {
                entry.onSelect();
                close('select');
              }}
            >
              {entry.badge !== undefined && <span className="gg-menu__badge">{entry.badge}</span>}
              <span className="gg-menu__label">{entry.label}</span>
              {entry.kind === 'radio' && <span className="gg-menu__check">{entry.checked ? '✓' : ''}</span>}
            </button>
          ) : (
            <div key={entry.id} role="separator" className="gg-menu__separator" />
          ),
        )}
      </div>
    </Popover>
  );
}

/** Open state plus trigger wiring for a menu button. */
export function useMenuState() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const close = useCallback(() => setOpen(false), []);
  const triggerProps = {
    ref: triggerRef,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: () => setOpen((value) => !value),
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true);
      }
    },
  };
  return { open, setOpen, close, triggerRef, triggerProps, menuId };
}

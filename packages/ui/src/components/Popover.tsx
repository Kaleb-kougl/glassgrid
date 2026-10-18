import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../cx.js';

export type PopoverPlacement = 'bottom-start' | 'bottom-end';

export interface PopoverProps {
  anchorRef: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  placement?: PopoverPlacement;
  className?: string;
  role?: string;
  'aria-label'?: string;
  id?: string;
  children: ReactNode;
}

const GAP = 4;
const MARGIN = 8;

/** Where a popover of `size` goes next to `anchor`, flipped and clamped to stay inside `viewport`. */
export function placePopover(
  anchor: { left: number; right: number; top: number; bottom: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  placement: PopoverPlacement,
): { left: number; top: number } {
  let left = placement === 'bottom-end' ? anchor.right - size.width : anchor.left;
  left = Math.max(MARGIN, Math.min(left, viewport.width - size.width - MARGIN));
  let top = anchor.bottom + GAP;
  if (top + size.height > viewport.height - MARGIN && anchor.top - GAP - size.height >= MARGIN) {
    top = anchor.top - GAP - size.height;
  }
  return { left, top: Math.max(MARGIN, top) };
}

/**
 * Floating panel anchored to an element, portalled into the nearest themed
 * ancestor so it inherits the theme's tokens but is never clipped by a
 * panel's `overflow: hidden`. Closes on an outside pointer press.
 */
export function Popover({ anchorRef, open, onClose, placement = 'bottom-start', className, children, ...aria }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    // The theme lives on an ancestor of the anchor; it is only known from the DOM.
    setContainer(anchorRef.current?.closest<HTMLElement>('[data-gg-theme]') ?? document.body);
  }, [open, anchorRef]);

  useLayoutEffect(() => {
    if (!open || !container) return;
    const anchor = anchorRef.current;
    const element = ref.current;
    if (!anchor || !element) return;
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      setPosition(
        placePopover(
          rect,
          { width: element.offsetWidth, height: element.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight },
          placement,
        ),
      );
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, container, anchorRef, placement]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (ref.current?.contains(target) || anchorRef.current?.contains(target))) return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, onClose, anchorRef]);

  if (!open || !container) return null;
  return createPortal(
    <div
      ref={ref}
      className={cx('gg-popover', className)}
      style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: 'hidden' }}
      {...aria}
    >
      {children}
    </div>,
    container,
  );
}

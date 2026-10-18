import { cloneElement, isValidElement, type ReactElement } from 'react';
import { cx } from '../cx.js';

export interface FocusRingProps {
  /** One focusable element. */
  children: ReactElement<{ className?: string }>;
  /** Draw the ring inside the element (grid cells, list rows) instead of 2px outside. */
  inset?: boolean;
}

/** Class names that give an element the keyboard focus ring (`:focus-visible` only). */
export function focusRingClass(inset = false): string {
  return inset ? 'gg-focus-ring--inset' : 'gg-focus-ring';
}

/**
 * Adds the token focus ring to its child: 2px in the focus colour, offset
 * 2px outside controls or inset on cells, shown for keyboard focus only.
 */
export function FocusRing({ children, inset = false }: FocusRingProps) {
  if (!isValidElement(children)) return children;
  return cloneElement(children, { className: cx(children.props.className, focusRingClass(inset)) });
}

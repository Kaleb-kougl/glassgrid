import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { cx } from '../cx.js';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'icon';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  variant?: ButtonVariant;
  /** `sm` (26px) in cards and panels, `md` (28px) in toolbars, `lg` (32px) for a screen's one primary action. */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Accessible name. Required for `icon` buttons, whose content is a glyph;
   * it is also shown as the tooltip, with the shortcut appended.
   */
  label?: string;
  /** Keyboard shortcut shown in the tooltip, e.g. `⌘Z`. */
  shortcut?: string;
  /** Tooltip text; defaults to `label` (+ shortcut). */
  title?: string;
  ref?: Ref<HTMLButtonElement>;
  children?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  label,
  shortcut,
  title,
  className,
  type = 'button',
  children,
  ...rest
}: ButtonProps) {
  const tooltip = title ?? (label ? (shortcut ? `${label} ${shortcut}` : label) : undefined);
  return (
    <button
      type={type}
      className={cx('gg-button', `gg-button--${variant}`, size !== 'md' && `gg-button--${size}`, className)}
      aria-label={variant === 'icon' ? label : undefined}
      title={tooltip}
      {...rest}
    >
      {children}
    </button>
  );
}

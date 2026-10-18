import { useRef, type KeyboardEvent } from 'react';
import { cx } from '../cx.js';

export interface SegmentedOption<V extends string> {
  readonly value: V;
  readonly label: string;
  readonly disabled?: boolean;
  /** Tooltip, e.g. why an option is disabled. */
  readonly title?: string;
}

export interface SegmentedControlProps<V extends string> {
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Accessible name of the group. */
  label: string;
  className?: string;
}

/**
 * A radio group drawn as segments. The selected segment is raised and set
 * in semibold; arrow keys move and select, Home/End jump; one tab stop.
 */
export function SegmentedControl<V extends string>({ options, value, onChange, label, className }: SegmentedControlProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((option, i) => ({ option, i })).filter(({ option }) => !option.disabled);

  const move = (event: KeyboardEvent, from: number) => {
    const position = enabled.findIndex(({ i }) => i === from);
    let next: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = enabled[(position + 1) % enabled.length]?.i;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = enabled[(position - 1 + enabled.length) % enabled.length]?.i;
    else if (event.key === 'Home') next = enabled[0]?.i;
    else if (event.key === 'End') next = enabled.at(-1)?.i;
    if (next === undefined) return;
    event.preventDefault();
    const target = options[next];
    if (!target) return;
    onChange(target.value);
    refs.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={label} className={cx('gg-segmented', className)}>
      {options.map((option, i) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              refs.current[i] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={option.disabled}
            title={option.title}
            className="gg-segmented__option"
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => move(event, i)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

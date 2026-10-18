import { COLUMN_TYPES, type ColumnType } from '@glassgrid/core';
import { cx } from '../cx.js';
import { Menu, useMenuState, type MenuEntry } from './Menu.js';

/** Short badge per type, as on the component sheet. */
export const TYPE_BADGES: Readonly<Record<ColumnType, string>> = {
  integer: '12',
  float: '1.2',
  decimal: '.00',
  boolean: 'T/F',
  date: 'Dt',
  timestamp: 'Ts',
  text: 'Aa',
};

export const TYPE_NAMES: Readonly<Record<ColumnType, string>> = {
  integer: 'Integer',
  float: 'Float',
  decimal: 'Decimal',
  boolean: 'Boolean',
  date: 'Date',
  timestamp: 'Timestamp',
  text: 'Text',
};

export interface TypeMenuProps {
  column: string;
  /** The effective type (override or inferred). */
  type: ColumnType;
  inferredType: ColumnType;
  onChange: (type: ColumnType) => void;
  /** Forwarded to the badge for E2E selectors. */
  testId?: string;
}

/**
 * The column type badge and its dropdown. A type the person set gets the
 * accent badge and says so in its tooltip; "Reset to inferred" goes back.
 */
export function TypeMenu({ column, type, inferredType, onChange, testId }: TypeMenuProps) {
  const menu = useMenuState();
  const overridden = type !== inferredType;
  const items: MenuEntry[] = [
    ...COLUMN_TYPES.map(
      (option): MenuEntry => ({
        kind: 'radio',
        id: option,
        label: TYPE_NAMES[option],
        badge: TYPE_BADGES[option],
        checked: option === type,
        onSelect: () => {
          if (option !== type) onChange(option);
        },
      }),
    ),
    { kind: 'separator', id: 'sep' },
    {
      id: 'reset',
      label: 'Reset to inferred',
      tone: 'muted',
      disabled: !overridden,
      onSelect: () => onChange(inferredType),
    },
  ];
  const typeLabel = `${type}${overridden ? ' (set by you)' : ''}`;
  return (
    <>
      <button
        type="button"
        {...menu.triggerProps}
        className={cx('gg-type-badge', overridden && 'gg-type-badge--set')}
        title={typeLabel}
        aria-label={`Type of ${column}: ${typeLabel}`}
        data-testid={testId}
        data-type={type}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <span>{TYPE_BADGES[type]}</span>
        <span className="gg-type-badge__caret" aria-hidden="true">
          ▾
        </span>
      </button>
      <Menu
        id={menu.menuId}
        anchorRef={menu.triggerRef}
        open={menu.open}
        onClose={menu.close}
        items={items}
        label={`Type of ${column}`}
        header={`${column} · inferred ${inferredType}`}
      />
    </>
  );
}

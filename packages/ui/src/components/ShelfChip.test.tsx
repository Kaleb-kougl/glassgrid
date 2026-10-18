import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { COLUMN_DRAG_TYPE } from './ColumnListRow.js';
import { ShelfChip } from './ShelfChip.js';

function columnDrag(name: string) {
  return { types: [COLUMN_DRAG_TYPE], getData: (type: string) => (type === COLUMN_DRAG_TYPE ? name : ''), dropEffect: 'none' };
}

describe('ShelfChip', () => {
  it('shows a filled shelf in words', () => {
    render(<ShelfChip shelf="X" value="month(pickup_datetime)" />);
    expect(screen.getByRole('group', { name: 'X: month(pickup_datetime)' }).textContent).toBe('Xmonth(pickup_datetime)');
  });

  it('is an empty drop target that turns into an accent target while a column is over it', () => {
    const onDropColumn = vi.fn();
    render(<ShelfChip shelf="Color" onDropColumn={onDropColumn} pendingColumn="payment_type" testId="chip" />);
    const chip = screen.getByTestId('chip');
    expect(chip.textContent).toBe('Colordrop a column');
    fireEvent.dragOver(chip, { dataTransfer: columnDrag('payment_type') });
    expect(chip.className).toContain('gg-shelf-chip--drop-target');
    expect(chip.textContent).toBe('Coloradd payment_type');
    fireEvent.drop(chip, { dataTransfer: columnDrag('payment_type') });
    expect(onDropColumn).toHaveBeenCalledWith('payment_type');
    expect(chip.className).not.toContain('gg-shelf-chip--drop-target');
  });

  it('keeps the aggregate inside the Y chip and changes it from the caret menu', async () => {
    const onSelect = vi.fn();
    render(
      <ShelfChip
        shelf="Y"
        value="sum(fare_amount)"
        menu={[
          { kind: 'radio', id: 'sum', label: 'sum', checked: true, onSelect: vi.fn() },
          { kind: 'radio', id: 'avg', label: 'avg', checked: false, onSelect },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Y: sum(fare_amount)' }));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /avg/ }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('is removable with × or Backspace and labels AI-added fields', async () => {
    const onRemove = vi.fn();
    render(<ShelfChip shelf="Color" value="payment_type" addedBy="ai" onRemove={onRemove} />);
    const chip = screen.getByRole('group', { name: 'Color: payment_type, added by AI' });
    expect(chip.textContent).toContain('AI');
    chip.focus();
    await userEvent.keyboard('{Backspace}');
    await userEvent.click(screen.getByRole('button', { name: 'Remove payment_type from Color' }));
    expect(onRemove).toHaveBeenCalledTimes(2);
  });
});

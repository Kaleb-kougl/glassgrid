import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { COLUMN_DRAG_TYPE, ColumnListRow } from './ColumnListRow.js';

function renderRow(props: Partial<Parameters<typeof ColumnListRow>[0]> = {}) {
  const onTypeChange = vi.fn();
  const onActivate = vi.fn();
  render(
    <ul>
      <ColumnListRow
        name="trip_distance"
        type="float"
        inferredType="float"
        distinct="4,218"
        onTypeChange={onTypeChange}
        onActivate={onActivate}
        testId="column-trip_distance"
        {...props}
      />
    </ul>,
  );
  return { onTypeChange, onActivate, row: screen.getByTestId('column-trip_distance') };
}

describe('ColumnListRow', () => {
  it('shows the type badge, name and distinct count', () => {
    const { row } = renderRow();
    expect(row.textContent).toBe('1.2▾trip_distance4,218');
    expect(row.getAttribute('data-selected')).toBe('false');
  });

  it('changes the type through the badge menu', async () => {
    const { onTypeChange } = renderRow();
    await userEvent.click(screen.getByTestId('column-trip_distance-type'));
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Decimal/ }));
    expect(onTypeChange).toHaveBeenCalledWith('decimal');
  });

  it('charts the column on Enter (keyboard path for drag and drop)', async () => {
    const { onActivate, row } = renderRow();
    row.focus();
    await userEvent.keyboard('{Enter}');
    expect(onActivate).toHaveBeenCalledOnce();
  });

  it('carries the column name while dragged and shows the dragging state', () => {
    const { row } = renderRow();
    const data = new Map<string, string>();
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), effectAllowed: 'none' };
    fireEvent.dragStart(row, { dataTransfer });
    expect(data.get(COLUMN_DRAG_TYPE)).toBe('trip_distance');
    expect(row.className).toContain('gg-column-row--dragging');
    fireEvent.dragEnd(row);
    expect(row.className).not.toContain('gg-column-row--dragging');
  });

  it('marks the grid selection and profiling', () => {
    const { row } = renderRow({ selected: true, profiling: true });
    expect(row.getAttribute('data-selected')).toBe('true');
    expect(row.getAttribute('aria-label')).toContain('in the grid selection');
    expect(screen.getByRole('progressbar', { name: 'Profiling trip_distance' })).toBeDefined();
  });
});

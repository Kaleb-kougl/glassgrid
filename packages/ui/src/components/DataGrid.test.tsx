import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataGrid, defaultColumnWidth, MAX_SCROLL_HEIGHT, scrollMapping, type GridColumn } from './DataGrid.js';

const columns: GridColumn[] = [
  { name: 'id', type: 'integer', width: 104 },
  { name: 'category', type: 'text', width: 160 },
  { name: 'created_on', type: 'date', width: 112 },
];
const rows = [
  ['1', 'alpha', '2026-01-01'],
  ['2', null, '2026-02-02'],
];

describe('scrollMapping', () => {
  it('is the identity below the browser height limit', () => {
    const mapping = scrollMapping(1_000, 600);
    expect(mapping.scaled).toBe(false);
    expect(mapping.spacer).toBe(32_000);
    expect(mapping.toVirtual(640)).toBe(640);
  });

  it('compresses very tall tables so the last row stays reachable', () => {
    const mapping = scrollMapping(10_000_000, 600);
    expect(mapping.scaled).toBe(true);
    expect(mapping.spacer).toBe(MAX_SCROLL_HEIGHT);
    expect(mapping.toVirtual(MAX_SCROLL_HEIGHT - 600)).toBeCloseTo(10_000_000 * 32 - 600);
    expect(mapping.toScroll(mapping.toVirtual(1234))).toBeCloseTo(1234);
  });
});

describe('defaultColumnWidth', () => {
  it('fits the header name and the type', () => {
    expect(defaultColumnWidth('id', 'integer')).toBe(104);
    expect(defaultColumnWidth('pickup_datetime', 'timestamp')).toBe(168);
  });
});

describe('DataGrid', () => {
  function renderGrid(overrides: Partial<Parameters<typeof DataGrid>[0]> = {}) {
    const onSortColumn = vi.fn();
    const onSelectedColumnsChange = vi.fn();
    const onVisibleRangeChange = vi.fn();
    render(
      <DataGrid
        columns={columns}
        rowCount={2}
        getRow={(i) => rows[i]}
        sort={[{ column: 'id', direction: 'asc' }]}
        onSortColumn={onSortColumn}
        onSelectedColumnsChange={onSelectedColumnsChange}
        onVisibleRangeChange={onVisibleRangeChange}
        label="Rows"
        testId="grid"
        {...overrides}
      />,
    );
    return { onSortColumn, onSelectedColumnsChange, onVisibleRangeChange };
  }

  it('renders an ARIA grid with the sort state, muted nulls and right-aligned numbers', () => {
    const { onVisibleRangeChange } = renderGrid();
    const grid = screen.getByRole('grid', { name: 'Rows' });
    expect(grid.getAttribute('aria-rowcount')).toBe('3');
    expect(screen.getByRole('columnheader', { name: /^id/ }).getAttribute('aria-sort')).toBe('ascending');
    expect(screen.getByRole('columnheader', { name: 'category' }).getAttribute('aria-sort')).toBe('none');
    const cells = screen.getAllByRole('gridcell');
    expect(cells.map((cell) => cell.textContent)).toEqual(['1', 'alpha', '2026-01-01', '2', 'null', '2026-02-02']);
    expect(cells[0]?.className).toContain('gg-grid__cell--num');
    expect(cells[2]?.className).toContain('gg-grid__cell--mono');
    expect(cells[4]?.className).toContain('gg-grid__cell--null');
    expect(onVisibleRangeChange).toHaveBeenCalledWith(0, 1);
  });

  it('sorts from the header', async () => {
    const { onSortColumn } = renderGrid();
    await userEvent.click(screen.getByRole('columnheader', { name: 'category' }));
    expect(onSortColumn).toHaveBeenCalledWith('category');
  });

  it('selects a range with the mouse and keyboard and reports its columns', async () => {
    const { onSelectedColumnsChange } = renderGrid();
    await userEvent.click(screen.getByText('alpha'));
    expect(onSelectedColumnsChange).toHaveBeenLastCalledWith(['category']);
    expect(screen.getByTestId('grid-focus')).toBeDefined();
    await userEvent.keyboard('{Shift>}{ArrowRight}{ArrowDown}{/Shift}');
    expect(onSelectedColumnsChange).toHaveBeenLastCalledWith(['category', 'created_on']);
    const selected = screen.getAllByRole('gridcell').filter((cell) => cell.getAttribute('aria-selected') === 'true');
    expect(selected.map((cell) => cell.textContent)).toEqual(['alpha', '2026-01-01', 'null', '2026-02-02']);
    await userEvent.keyboard('{Escape}');
    expect(onSelectedColumnsChange).toHaveBeenLastCalledWith([]);
  });

  it('shows placeholders for rows that are still loading', () => {
    renderGrid({ getRow: () => undefined });
    expect(screen.getAllByRole('gridcell')[0]?.className).toContain('gg-grid__cell--placeholder');
  });
});

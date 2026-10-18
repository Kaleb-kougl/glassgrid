import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChartCard } from './ChartCard.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('ChartCard', () => {
  it('names the card by its title and description, and makes "View data" a focusable region', () => {
    render(
      <ChartCard title="Rows over pickup_at" description="Area chart, 2 of 3" viewData={{ on: true, onToggle: () => undefined, table: <table aria-label="t" /> }} testId="card">
        <p>chart</p>
      </ChartCard>,
    );
    expect(screen.getByRole('region', { name: 'Rows over pickup_at Area chart, 2 of 3' })).toBeDefined();
    const data = screen.getByRole('region', { name: 'Rows over pickup_at (Area chart, 2 of 3): data' });
    expect(data.tabIndex).toBe(0);
  });

  it('shows the skeleton only after the load has taken 300 ms', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ChartCard title="Trips by payment type" status="loading" testId="card">
        <p>chart</p>
      </ChartCard>,
    );
    const card = screen.getByTestId('card');
    expect(card.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('chart')).toBeDefined();
    expect(screen.queryByText('Updating…')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(card.getAttribute('data-status')).toBe('loading');
    expect(card.querySelector('.gg-chart-skeleton')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(card.querySelector('.gg-chart-skeleton')).not.toBeNull();
    expect(screen.getByText('Updating…')).toBeDefined();
    rerender(
      <ChartCard title="Trips by payment type" status="ready" testId="card">
        <p>chart</p>
      </ChartCard>,
    );
    expect(card.querySelector('.gg-chart-skeleton')).toBeNull();
    expect(screen.getByText('chart')).toBeDefined();
  });

  it('shows the engine message verbatim on error', () => {
    render(
      <ChartCard
        title="Fare"
        status="error"
        error={{ message: 'y.aggregate "sum" needs a numeric column, but "category" is text. Use "count" instead.', detail: 'y.aggregate' }}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This chart could not be computed');
    expect(alert.textContent).toContain('y.aggregate "sum" needs a numeric column');
  });

  it('edits the title: Enter commits, Escape cancels', async () => {
    const onRename = vi.fn();
    render(<ChartCard title="Trips per day" onRename={onRename} />);
    await userEvent.click(screen.getByRole('button', { name: 'Trips per day' }));
    const input = screen.getByRole('textbox', { name: 'Chart title' });
    await userEvent.clear(input);
    await userEvent.type(input, 'Fare by pickup hour{Enter}');
    expect(onRename).toHaveBeenCalledWith('Fare by pickup hour');

    await userEvent.click(screen.getByRole('button', { name: 'Trips per day' }));
    await userEvent.type(screen.getByRole('textbox', { name: 'Chart title' }), 'x{Escape}');
    expect(onRename).toHaveBeenCalledOnce();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('offers Rename and caller items in the ⋯ menu, and Clear for its selection', async () => {
    const onRemove = vi.fn();
    const onClear = vi.fn();
    render(
      <ChartCard
        title="Trips by hour"
        attribution="ai"
        onRename={vi.fn()}
        menu={[{ id: 'remove', label: 'Remove chart', tone: 'danger', onSelect: onRemove }]}
        selection={{ summary: '1 selected', onClear }}
      />,
    );
    expect(screen.getByText('by AI')).toBeDefined();
    expect(screen.getByText('1 selected')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Chart actions' }));
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Rename…', 'Remove chart']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Remove chart' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('switches to the data table with "View data"', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <ChartCard title="T" viewData={{ on: false, onToggle, table: <table aria-label="rows" /> }} rowsLabel="5 rows">
        <p>chart</p>
      </ChartCard>,
    );
    const toggle = screen.getByRole('switch', { name: 'View data' });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);
    rerender(
      <ChartCard title="T" viewData={{ on: true, onToggle, table: <table aria-label="rows" /> }} rowsLabel="5 rows">
        <p>chart</p>
      </ChartCard>,
    );
    expect(screen.getByRole('table', { name: 'rows' })).toBeDefined();
    expect(screen.queryByText('chart')).toBeNull();
    expect(screen.getByText('5 rows')).toBeDefined();
  });

  it('accepts a dropped column', () => {
    const onDropColumn = vi.fn();
    render(<ChartCard title="T" onDropColumn={onDropColumn} testId="card" />);
    const dataTransfer = { types: ['application/x-glassgrid-column'], getData: () => 'fare_amount', dropEffect: 'none' };
    fireEvent.dragOver(screen.getByTestId('card'), { dataTransfer });
    fireEvent.drop(screen.getByTestId('card'), { dataTransfer });
    expect(onDropColumn).toHaveBeenCalledWith('fare_amount');
  });
});

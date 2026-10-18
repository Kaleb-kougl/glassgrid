import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { HistoryItem } from './HistoryItem.js';

describe('HistoryItem', () => {
  it('attributes each change to its caller', () => {
    render(
      <ol>
        <HistoryItem label="Selected payment_type = Cash" caller="user" time="14:28" state="applied" testId="h1" />
        <HistoryItem label="Added chart “Trips by hour and weekday”" caller="ai" time="14:32" state="current" testId="h2" />
      </ol>,
    );
    expect(screen.getByTestId('h1-caller').textContent).toBe('by you · 14:28');
    expect(screen.getByTestId('h2-caller').textContent).toBe('by AI · 14:32');
    expect(screen.getByTestId('h2').getAttribute('data-current')).toBe('true');
  });

  it('marks undone entries and steps to an entry when selected', async () => {
    const onSelect = vi.fn();
    render(
      <ol>
        <HistoryItem label="Filter trip_distance < 2.00" caller="user" state="undone" onSelect={onSelect} testId="h" />
      </ol>,
    );
    expect(screen.getByTestId('h').getAttribute('data-undone')).toBe('true');
    const button = screen.getByRole('button', { name: 'Filter trip_distance < 2.00, by you, undone' });
    expect(button.className).toContain('gg-history-item--undone');
    await userEvent.click(button);
    expect(onSelect).toHaveBeenCalledOnce();
  });
});

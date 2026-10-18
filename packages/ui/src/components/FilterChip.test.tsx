import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterChip } from './FilterChip.js';

describe('FilterChip', () => {
  it('names the column and the condition in words', () => {
    render(<FilterChip column="payment_type" condition="= Cash" onRemove={vi.fn()} />);
    const chip = screen.getByRole('group', { name: 'Filter payment_type = Cash' });
    expect(chip.textContent).toBe('payment_type= Cash×');
  });

  it('is removed by its × button', async () => {
    const onRemove = vi.fn();
    render(<FilterChip column="trip_distance" condition="2.00 – 6.00" onRemove={onRemove} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter on trip_distance' }));
    expect(onRemove).toHaveBeenCalledOnce();
  });

  it('is removed by Backspace or Delete when focused', async () => {
    const onRemove = vi.fn();
    render(<FilterChip column="pickup_datetime" condition="Jan 9 – Jan 15" onRemove={onRemove} />);
    await userEvent.tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Filter pickup_datetime Jan 9 – Jan 15');
    await userEvent.keyboard('{Backspace}');
    await userEvent.keyboard('{Delete}');
    expect(onRemove).toHaveBeenCalledTimes(2);
  });
});

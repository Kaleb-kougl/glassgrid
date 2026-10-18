import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SegmentedControl } from './SegmentedControl.js';

function Harness() {
  const [value, setValue] = useState<'bar' | 'line' | 'area' | 'histogram'>('line');
  return (
    <SegmentedControl
      label="Chart type"
      value={value}
      onChange={setValue}
      options={[
        { value: 'bar', label: 'Bar' },
        { value: 'line', label: 'Line' },
        { value: 'area', label: 'Area', disabled: true },
        { value: 'histogram', label: 'Histogram' },
      ]}
    />
  );
}

describe('SegmentedControl', () => {
  it('is a radio group with one tab stop on the selected segment', async () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Chart type' })).toBeDefined();
    expect(screen.getByRole('radio', { name: 'Line' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Line' }));
    expect(screen.getByRole('radio', { name: 'Bar' }).tabIndex).toBe(-1);
  });

  it('moves and selects with the arrow keys, skipping disabled segments', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('radio', { name: 'Line' }));
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Histogram' }).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Histogram' }));
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Bar' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('radio', { name: 'Histogram' }).getAttribute('aria-checked')).toBe('true');
    await userEvent.click(screen.getByRole('radio', { name: 'Area' }));
    expect(screen.getByRole('radio', { name: 'Area' }).getAttribute('aria-checked')).toBe('false');
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { resolvedTokens } from '../tokens.js';
import { BAR_LABEL_WIDTH, BarChart, hitTestBars, layoutBars, type BarDatum } from './BarChart.js';

const data: BarDatum[] = [
  { key: '"Credit card"', label: 'Credit card', value: 2_688_301 },
  { key: '"Cash"', label: 'Cash', value: 631_488 },
  { key: 'null', label: 'null', isNull: true, value: 152_906 },
];

describe('layoutBars', () => {
  it('lays out 20px rows 6px apart and scales bars to the largest value', () => {
    const layout = layoutBars(data, 432, 60);
    expect(layout.height).toBe(3 * 20 + 2 * 6);
    expect(layout.bars.map((bar) => bar.rowTop)).toEqual([0, 26, 52]);
    const full = 432 - (BAR_LABEL_WIDTH + 8) - 1 - 6 - 60;
    expect(layout.bars[0]?.width).toBeCloseTo(full);
    expect(layout.bars[1]?.width).toBeCloseTo((full * 631_488) / 2_688_301);
  });

  it('hit-tests whole rows, labels included', () => {
    const layout = layoutBars(data, 432, 60);
    expect(hitTestBars(layout, { x: 10, y: 30 })).toBe(1);
    expect(hitTestBars(layout, { x: 300, y: 21 })).toBe(-1);
    expect(hitTestBars(layout, { x: 500, y: 5 })).toBe(-1);
  });
});

describe('BarChart', () => {
  it('exposes the bars as options and toggles one with the keyboard', async () => {
    const onToggle = vi.fn();
    render(
      <BarChart
        data={data}
        selected={new Set(['"Cash"'])}
        onToggle={onToggle}
        tokens={resolvedTokens.dark}
        valueLabel="count(*)"
        label="Trips by payment type"
        testId="chart"
      />,
    );
    const chart = screen.getByRole('listbox', { name: 'Trips by payment type' });
    const options = screen.getAllByRole('option');
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(options[1]?.textContent).toBe('Cash: 631,488');
    chart.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onToggle).toHaveBeenCalledWith(data[2]);
    expect(chart.getAttribute('aria-activedescendant')).toBe(options[2]?.id);
    await userEvent.keyboard('{Home} ');
    expect(onToggle).toHaveBeenLastCalledWith(data[0]);
  });
});

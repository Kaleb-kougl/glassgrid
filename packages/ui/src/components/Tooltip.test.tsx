import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { placeTooltip, Tooltip } from './Tooltip.js';

const container = { width: 432, height: 160 };
const size = { width: 140, height: 40 };

describe('placeTooltip', () => {
  it('goes right of and below the anchor when there is room', () => {
    expect(placeTooltip({ x: 100, y: 20 }, size, container)).toEqual({ left: 110, top: 30, flippedX: false, flippedY: false });
  });

  it('flips left near the right edge and up near the bottom edge', () => {
    expect(placeTooltip({ x: 400, y: 140 }, size, container)).toEqual({ left: 250, top: 90, flippedX: true, flippedY: true });
  });

  it('never leaves the container', () => {
    const placed = placeTooltip({ x: 60, y: 10 }, { width: 300, height: 200 }, container);
    expect(placed.left).toBeGreaterThanOrEqual(0);
    expect(placed.top).toBe(0);
    expect(placed.left + 300).toBeLessThanOrEqual(container.width);
  });
});

describe('Tooltip', () => {
  it('shows exact values from the aggregate rows', () => {
    render(<Tooltip anchor={{ x: 0, y: 0 }} title="trip_distance 3.00 – 4.00" rows={[{ label: 'count(*)', value: '160,402' }]} />);
    const tooltip = screen.getByRole('tooltip');
    expect(tooltip.textContent).toBe('trip_distance 3.00 – 4.00count(*)160,402');
  });
});

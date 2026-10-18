import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FocusRing, focusRingClass } from './FocusRing.js';

describe('FocusRing', () => {
  it('adds the ring class and keeps the child’s own classes', () => {
    render(
      <FocusRing>
        <div tabIndex={0} className="card">
          Chart card
        </div>
      </FocusRing>,
    );
    expect(screen.getByText('Chart card').className).toBe('card gg-focus-ring');
  });

  it('has an inset variant for grid cells', () => {
    render(
      <FocusRing inset>
        <div tabIndex={0}>161</div>
      </FocusRing>,
    );
    expect(screen.getByText('161').className).toBe(focusRingClass(true));
  });
});

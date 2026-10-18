import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProgressBar, Spinner } from './ProgressIndicator.js';

describe('ProgressBar', () => {
  it('reports a known fraction as a percentage', () => {
    render(<ProgressBar variant="titlebar" label="Optimizing file" value={0.38} title="Building a columnar copy for fast queries." />);
    const bar = screen.getByRole('progressbar', { name: 'Optimizing file' });
    expect(bar.getAttribute('aria-valuenow')).toBe('38');
    expect(screen.getByText('38%')).toBeDefined();
    expect(screen.getByText('Optimizing file')).toBeDefined();
  });

  it('is indeterminate while the amount is unknown', () => {
    const { container } = render(<ProgressBar variant="mini" label="Profiling PULocationID" value={null} />);
    const bar = screen.getByRole('progressbar', { name: 'Profiling PULocationID' });
    expect(bar.getAttribute('aria-valuenow')).toBeNull();
    expect(bar.getAttribute('aria-valuetext')).toBe('Profiling PULocationID…');
    expect(container.firstElementChild?.className).toContain('gg-progress--indeterminate');
  });

  it('clamps out-of-range values', () => {
    render(<ProgressBar label="Reading" value={1.4} />);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
  });
});

describe('Spinner', () => {
  it('carries its state in text', () => {
    render(<Spinner label="Updating…" />);
    expect(screen.getByRole('status').textContent).toBe('Updating…');
  });
});

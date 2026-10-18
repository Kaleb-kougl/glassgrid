import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AgentIndicator } from './AgentIndicator.js';

describe('AgentIndicator', () => {
  it('is a quiet placeholder until v2', () => {
    render(<AgentIndicator status="off" />);
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Agent · not connected');
    expect(status.getAttribute('title')).toBe('Agent connection (v2)');
    expect(status.className).toContain('gg-agent--off');
  });

  it('shows a connected agent that is editing', () => {
    render(<AgentIndicator status="editing" />);
    expect(screen.getByRole('status').textContent).toBe('Agent connected· editing');
  });
});

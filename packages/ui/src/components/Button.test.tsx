import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button.js';

describe('Button', () => {
  it('gives icon buttons an accessible name and a tooltip with the shortcut', async () => {
    const onClick = vi.fn();
    render(
      <Button variant="icon" label="Undo" shortcut="⌘Z" onClick={onClick}>
        ↶
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'Undo' });
    expect(button).toHaveProperty('title', 'Undo ⌘Z');
    expect(button.className).toContain('gg-button--icon');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('is keyboard operable and inert when disabled', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<Button onClick={onClick}>Open file</Button>);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Open file' }));
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
    rerender(
      <Button onClick={onClick} disabled>
        Open file
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Open file' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('defaults to type="button" so it never submits a form', () => {
    render(<Button variant="primary">Open CSV…</Button>);
    expect(screen.getByRole('button')).toHaveProperty('type', 'button');
  });
});

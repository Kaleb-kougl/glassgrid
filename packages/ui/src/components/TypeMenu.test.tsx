import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TypeMenu } from './TypeMenu.js';

describe('TypeMenu', () => {
  it('opens from the badge and sets a type', async () => {
    const onChange = vi.fn();
    render(<TypeMenu column="payment_type" type="integer" inferredType="integer" onChange={onChange} />);
    const badge = screen.getByRole('button', { name: 'Type of payment_type: integer' });
    expect(badge.getAttribute('aria-haspopup')).toBe('menu');
    await userEvent.click(badge);
    const menu = screen.getByRole('menu', { name: 'Type of payment_type' });
    expect(menu.textContent).toContain('payment_type · inferred integer');
    expect(screen.getByRole('menuitemradio', { name: /Integer/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('menuitem', { name: 'Reset to inferred' })).toHaveProperty('disabled', true);
    await userEvent.click(screen.getByRole('menuitemradio', { name: /Text/ }));
    expect(onChange).toHaveBeenCalledWith('text');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('is keyboard operable: arrows, Enter, Escape returns focus', async () => {
    const onChange = vi.fn();
    render(<TypeMenu column="amount" type="text" inferredType="float" onChange={onChange} />);
    const badge = screen.getByRole('button', { name: 'Type of amount: text (set by you)' });
    expect(badge.className).toContain('gg-type-badge--set');
    badge.focus();
    await userEvent.keyboard('{ArrowDown}');
    // Focus lands on the checked item.
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Text'));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(badge);

    await userEvent.keyboard('{ArrowDown}');
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Text'));
    await userEvent.keyboard('{ArrowDown}'); // wraps to "Reset to inferred"
    expect(document.activeElement?.textContent).toBe('Reset to inferred');
    await userEvent.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('float');
  });
});

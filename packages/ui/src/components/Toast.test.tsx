import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Toast } from './Toast.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('Toast', () => {
  it('offers Undo, announces politely and leaves after 6 s', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    const onUndo = vi.fn();
    render(<Toast message="Removed filter payment_type" action={{ label: 'Undo', shortcut: '⌘Z', onClick: onUndo }} onDismiss={onDismiss} />);
    expect(screen.getByRole('status').textContent).toContain('Removed filter payment_type');
    act(() => {
      vi.advanceTimersByTime(5999);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('runs its action and dismisses itself', async () => {
    const onDismiss = vi.fn();
    const onUndo = vi.fn();
    render(<Toast message="Added chart" by="by AI" action={{ label: 'Undo', shortcut: '⌘Z', onClick: onUndo }} onDismiss={onDismiss} />);
    expect(screen.getByText('by AI')).toBeDefined();
    await userEvent.click(screen.getByRole('button', { name: /Undo/ }));
    expect(onUndo).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalled();
  });

  it('keeps error toasts until dismissed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onDismiss = vi.fn();
    render(<Toast tone="error" message="Couldn't open trips.csv: file is locked" onDismiss={onDismiss} />);
    expect(screen.getByRole('alert').textContent).toContain('file is locked');
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onDismiss).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

/**
 * @vitest-environment jsdom
 */
import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { fakeEngine, handle } from './test-support/fake-engine';
import { fakePlatform } from './test-support/fake-platform';
import { stubLayout } from './test-support/jsdom';
import { createAppWorkspace } from './workspace';

/*
 * `initialOpen`: the shell's open at start (the web demo's `/?sample=` links)
 * runs once through the same path as the Open button, StrictMode included.
 */

const picked = { status: 'opened' as const, file: { handle, displayName: 'trips.csv', sizeBytes: 2048 } };

beforeEach(() => stubLayout());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('App initialOpen', () => {
  it('opens once at mount, even under StrictMode, like a pick', async () => {
    const workspace = createAppWorkspace();
    const { platform } = fakePlatform(fakeEngine(), { name: 'web' });
    const initialOpen = vi.fn(() => Promise.resolve(picked));
    render(
      <StrictMode>
        <App platform={platform} workspace={workspace} initialOpen={initialOpen} />
      </StrictMode>,
    );
    await waitFor(() => expect(screen.getByTestId('row-count').textContent).toBe('2 rows'));
    expect(screen.getByTestId('file-name').textContent).toBe('trips.csv');
    expect(initialOpen).toHaveBeenCalledOnce();
  });

  it('shows a failed initial open as an error the person can retry', async () => {
    const { platform } = fakePlatform(fakeEngine(), { name: 'web' });
    const initialOpen = vi.fn(() => Promise.resolve({ status: 'failed' as const, message: 'The sample is not available' }));
    render(<App platform={platform} workspace={createAppWorkspace()} initialOpen={initialOpen} />);
    expect((await screen.findByRole('alert')).textContent).toContain('The sample is not available');
    screen.getByRole('button', { name: 'Retry' }).click();
    await waitFor(() => expect(initialOpen).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('empty-state')).toBeTruthy();
  });
});

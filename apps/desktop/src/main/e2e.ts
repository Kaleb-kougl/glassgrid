/**
 * Test hooks for Playwright. They are inert unless GLASSGRID_E2E=1, so a
 * stray GLASSGRID_E2E_OPEN in a user's environment cannot change behaviour.
 */
import { app } from 'electron';

export const isE2E = process.env['GLASSGRID_E2E'] === '1';

/**
 * Point userData (and with it the Parquet cache) at a throwaway folder so
 * test runs neither read nor pollute the developer's real cache.
 */
export function applyE2EOverrides(): void {
  if (!isE2E) return;
  const userData = process.env['GLASSGRID_E2E_USER_DATA'];
  if (userData) app.setPath('userData', userData);
}

/** Path to open instead of showing the native dialog, when under test. */
export function e2eOpenPath(): string | undefined {
  if (!isE2E) return undefined;
  const path = process.env['GLASSGRID_E2E_OPEN'];
  return path && path.length > 0 ? path : undefined;
}

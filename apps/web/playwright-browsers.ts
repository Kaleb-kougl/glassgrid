/**
 * GLASSGRID_E2E_BROWSERS for playwright.config.ts: a comma-separated subset of chromium, firefox, webkit; unset means
 * chromium. An empty or unknown value is an error, so a typo never runs zero projects and passes.
 */
export const E2E_BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
export type E2eBrowser = (typeof E2E_BROWSERS)[number];

export function parseBrowsers(value: string | undefined): E2eBrowser[] {
  if (value === undefined) return ['chromium'];
  const names = value.split(',').map((name) => name.trim());
  const unknown = names.filter((name) => !(E2E_BROWSERS as readonly string[]).includes(name));
  if (names.length === 0 || unknown.length > 0) {
    throw new Error(`GLASSGRID_E2E_BROWSERS=${JSON.stringify(value)}: expected a comma-separated subset of ${E2E_BROWSERS.join(', ')}${unknown.length > 0 ? ` (not: ${unknown.map((name) => JSON.stringify(name)).join(', ')})` : ''}`);
  }
  return [...new Set(names as E2eBrowser[])];
}

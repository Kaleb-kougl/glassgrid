import { expect, type Page } from '@playwright/test';
import { parseBase } from '../hosting.ts';

/*
 * Shared by the web E2E specs: everything that would mean the demo is
 * broken in production, collected per page.
 *
 * - console errors and uncaught exceptions (a CSP violation on the page is
 *   a console error);
 * - CSP violations reported to the page (`securitypolicyviolation`);
 * - error toasts (role=alert): a violation inside the engine worker never
 *   reaches the page's console, but the failed query does reach the UI;
 * - HTTP responses >= 400 (a missing asset, extension or sample);
 * - failed requests, except aborted ones (a HEAD whose body is never read,
 *   a superseded fetch);
 * - `[glassgrid]` warnings (extensions that failed to load, a sample whose
 *   workspace no longer fits its data);
 * - under a base (GLASSGRID_BASE), any same-origin request outside it.
 */

/** The base the build under test is served at (playwright.config.ts). */
export const BASE = parseBase(process.env['GLASSGRID_BASE']);

export interface Problems {
  readonly list: string[];
  /** `[glassgrid] …` info lines (engine start-up). */
  readonly info: string[];
}

declare global {
  interface Window {
    __ggProblems?: string[];
  }
}

export async function watchProblems(page: Page, options: { alerts?: boolean } = {}): Promise<Problems> {
  const problems: Problems = { list: [], info: [] };
  page.on('console', (message) => {
    const text = message.text();
    if (message.type() === 'error') problems.list.push(`console.error: ${text}`);
    else if (message.type() === 'warning' && text.startsWith('[glassgrid]')) problems.list.push(`console.warn: ${text}`);
    else if (message.type() === 'info' && text.startsWith('[glassgrid]')) problems.info.push(text);
  });
  page.on('pageerror', (error) => problems.list.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400) problems.list.push(`HTTP ${response.status()} ${response.request().method()} ${response.url()}`);
  });
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (BASE === '/' || !/^https?:$/.test(url.protocol)) return;
    if (url.pathname !== BASE.slice(0, -1) && !url.pathname.startsWith(BASE)) problems.list.push(`outside ${BASE}: ${request.method()} ${request.url()}`);
  });
  page.on('requestfailed', (request) => {
    const failure = request.failure()?.errorText ?? '';
    if (!failure.includes('ERR_ABORTED')) problems.list.push(`request failed: ${request.method()} ${request.url()} ${failure}`);
  });
  await page.addInitScript((alerts) => {
    const seen: string[] = [];
    window.__ggProblems = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`CSP violation: ${event.violatedDirective} blocked ${event.blockedURI || '(inline)'} at ${event.sourceFile}:${event.lineNumber}`);
    });
    if (!alerts) return;
    new MutationObserver(() => {
      for (const alert of document.querySelectorAll('[role="alert"]')) {
        const text = `error toast: ${alert.textContent}`;
        if (!seen.includes(text)) seen.push(text);
      }
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, options.alerts ?? true);
  return problems;
}

/** Fails with everything collected so far (page-side records included). */
export async function expectNoProblems(page: Page, problems: Problems): Promise<void> {
  const fromPage = await page.evaluate(() => window.__ggProblems ?? []).catch(() => [] as string[]);
  expect([...problems.list, ...fromPage]).toEqual([]);
}

/** The engine reported itself ready with Parquet (the extension loaded from /duckdb-extensions). */
export async function expectEngineWithParquet(problems: Problems): Promise<string> {
  await expect.poll(() => problems.info.find((line) => line.includes('DuckDB-WASM')) ?? '', { timeout: 60_000 }).toContain('ready');
  const line = problems.info.find((entry) => entry.includes('DuckDB-WASM')) ?? '';
  expect(line).toMatch(/DuckDB-WASM v1\.4\.3 ready \(parquet: true, cache: (opfs|none), cross-origin isolated: false\)/);
  return line;
}

export function digits(text: string | null): string {
  return (text ?? '').replace(/[^0-9]/g, '');
}

/** Number of rows the grid's status shows ("1,234 rows" or "12 of 1,234 rows": the first number). */
export async function shownRows(page: Page): Promise<number> {
  const text = (await page.getByTestId('row-count').textContent()) ?? '';
  const first = /^([\d,]+)/.exec(text.trim());
  return first ? Number((first[1] ?? '').replaceAll(',', '')) : Number.NaN;
}

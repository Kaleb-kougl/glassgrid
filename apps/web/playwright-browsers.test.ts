import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BENCHMARK_DIR } from './e2e/results';
import { parseBrowsers } from './playwright-browsers';

/* The E2E configuration's inputs (L5 review): which browsers run, and where the benchmarks keep their JSON. */

describe('GLASSGRID_E2E_BROWSERS', () => {
  it('defaults to Chromium and takes any subset of the three', () => {
    expect(parseBrowsers(undefined)).toEqual(['chromium']);
    expect(parseBrowsers('firefox,webkit')).toEqual(['firefox', 'webkit']);
    expect(parseBrowsers(' chromium , firefox,chromium')).toEqual(['chromium', 'firefox']);
  });

  it('fails loudly on an empty or unknown value instead of running no browser', () => {
    expect(() => parseBrowsers('')).toThrow(/GLASSGRID_E2E_BROWSERS=""/);
    expect(() => parseBrowsers('firefox,safari')).toThrow(/not: "safari"/);
    expect(() => parseBrowsers(',')).toThrow(/expected a comma-separated subset/);
  });
});

describe('benchmark JSON', () => {
  it('goes to e2e-results/, outside Playwright’s outputDir, which the next run empties; both benchmarks use it', () => {
    expect(basename(BENCHMARK_DIR)).toBe('e2e-results');
    const config = readFileSync(join(import.meta.dirname, 'playwright.config.ts'), 'utf8');
    expect(config).toMatch(/outputDir: '\.\/test-results'/);
    for (const spec of ['flights-perf.spec.ts', 'map-perf.spec.ts']) {
      const source = readFileSync(join(import.meta.dirname, 'e2e', spec), 'utf8');
      expect(source).toContain('const dir = BENCHMARK_DIR;');
      expect(source).not.toMatch(/'test-results'/);
    }
  });
});

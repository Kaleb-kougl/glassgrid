import { join } from 'node:path';

/**
 * Where the opt-in benchmarks (flights-perf.spec.ts, map-perf.spec.ts) write their JSON: `apps/web/e2e-results/`,
 * outside Playwright's `outputDir` (`test-results/`), which every run empties, so the next run (say `e2e:map-perf`
 * after the brush benchmark) does not delete the last one's numbers. Gitignored; copied to docs/benchmarks by hand.
 */
export const BENCHMARK_DIR = join(import.meta.dirname, '..', 'e2e-results');

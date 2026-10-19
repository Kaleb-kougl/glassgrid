import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { vercelConfig } from '../hosting.ts';

/*
 * Rewrites apps/web/vercel.json from hosting.ts (the one source of the
 * demo's headers and rewrites; dist/glassgrid-hosting.json comes from the
 * same rules). src/hosting.test.ts fails when the committed file is stale.
 *
 *   pnpm --filter @glassgrid/web hosting
 */

const file = join(resolve(import.meta.dirname, '..'), 'vercel.json');
writeFileSync(file, `${JSON.stringify(vercelConfig(), null, 2)}\n`);
console.info(`[hosting] wrote ${file}`);

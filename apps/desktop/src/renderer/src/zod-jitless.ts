import { config } from 'zod';

/*
 * Zod compiles fast object parsers with `new Function` when it can, and
 * finds out whether it can by trying once. Under the renderer's CSP (no
 * 'unsafe-eval') that probe throws and is caught, but the browser still
 * reports a `securitypolicyviolation`. `jitless` skips both: same results,
 * the interpreted parser. Imported first by the renderer's main.tsx, before any schema
 * parses (same as apps/web).
 */
config({ jitless: true });

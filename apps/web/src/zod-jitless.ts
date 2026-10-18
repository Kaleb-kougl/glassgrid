import { config } from 'zod';

/*
 * Zod compiles fast object parsers with `new Function` when it can, and
 * finds out whether it can by trying once. Under the demo's CSP (no
 * 'unsafe-eval') that probe throws and is caught, but the browser still
 * reports a `securitypolicyviolation`. `jitless` skips both: same results,
 * the interpreted parser. Imported first by main.tsx, before any schema
 * parses; the engine worker does the same for its own copy of the config.
 */
config({ jitless: true });

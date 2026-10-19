/*
 * The web demo's Content Security Policy, in one place: vite.config.ts puts
 * WEB_CSP in the built index.html as a <meta>, and vercel.json sends
 * WEB_CSP_HEADER on every response (src/headers.test.ts keeps the two in
 * step). Only the header reaches the engine's Web Worker: a dedicated
 * worker is governed by the policy delivered with its own script, not the
 * page's <meta>.
 *
 * - `'wasm-unsafe-eval'`: compiling DuckDB-WASM and its Parquet extension
 *   (WebAssembly only; JavaScript eval and `new Function` stay refused).
 * - `connect-src 'self'`: the worker fetches DuckDB's .wasm, the Parquet
 *   extension (/duckdb-extensions/) and the sample data (/samples/) from
 *   this origin, and nothing else.
 * - `worker-src 'self'`: the engine worker is a same-origin module script.
 */
const DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

/** As a <meta http-equiv>: everything a meta element may carry. */
export const WEB_CSP = DIRECTIVES.join('; ');

/** As a response header: the same policy plus `frame-ancestors` (ignored, with a console error, in a <meta>). */
export const WEB_CSP_HEADER = [...DIRECTIVES, "frame-ancestors 'none'"].join('; ');

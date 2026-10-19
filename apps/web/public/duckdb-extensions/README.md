# DuckDB-WASM extensions served by the web demo

DuckDB-WASM does not link Parquet in: `read_parquet` and `COPY … (FORMAT
parquet)` exist only after `LOAD parquet`. The engine worker loads it once at
start, before it locks DuckDB's configuration, from
`custom_extension_repository = <origin>/duckdb-extensions`
(`createWorkerEngine({ extensionRepository })` in `apps/web/src/web-engine.ts`).
DuckDB then fetches `<repository>/<duckdb version>/<platform>/parquet.duckdb_extension.wasm`.
Serving the files from our own origin keeps `connect-src 'self'` and
works without extensions.duckdb.org.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `v1.4.3/wasm_eh/parquet.duckdb_extension.wasm` | 3,045,039 | `22765c8f7dc741cda2b571a66ac7bb355295d7d69a6c37e5315b265672984f55` |
| `v1.4.3/wasm_mvp/parquet.duckdb_extension.wasm` | 2,867,304 | `0785c6c95d003eff4faa7b3b4b660f02c9c92f6d68d135ddf330d42e3a650600` |

- **Source:** `https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm`
  and `https://extensions.duckdb.org/v1.4.3/wasm_mvp/parquet.duckdb_extension.wasm`,
  downloaded 2026-10-18 and stored unmodified.
- **Version:** DuckDB v1.4.3, the DuckDB inside `@duckdb/duckdb-wasm` 1.32.0
  (pinned in `packages/engine/package.json`). An extension only loads into the
  DuckDB version it was built for.
- **Signed:** each file is a WebAssembly module (`\0asm` magic) ending in
  DuckDB's `duckdb_signature` custom section. The engine opens DuckDB with
  `allowUnsignedExtensions: false`, so a modified file is refused.
- **Builds:** `wasm_eh` for browsers with WebAssembly exception handling (all
  current ones), `wasm_mvp` for the rest. `wasm_threads` (the COI build) is
  not served: the engine does not use DuckDB-WASM's threads.
- **Licence:** MIT, like DuckDB itself (Stichting DuckDB Foundation;
  <https://github.com/duckdb/duckdb/blob/main/LICENSE>).
- **Caching:** the path carries the DuckDB version, so the host serves these
  files as immutable (`apps/web/vercel.json`).

## When bumping DuckDB-WASM

1. Find the new DuckDB version: `SELECT version()` in the new build (see
   `docs/m4-engine-portability.md`, "DuckDB-WASM version").
2. Download both builds for it:

   ```sh
   v=v1.4.3   # the new DuckDB version
   for p in wasm_eh wasm_mvp; do
     mkdir -p apps/web/public/duckdb-extensions/$v/$p
     curl -fsSL -o apps/web/public/duckdb-extensions/$v/$p/parquet.duckdb_extension.wasm \
       https://extensions.duckdb.org/$v/$p/parquet.duckdb_extension.wasm
   done
   ```

3. Check each file starts with `00 61 73 6d` and contains `duckdb_signature`,
   record the sizes and SHA-256 above, and delete the old version's folder.
4. `pnpm --filter @glassgrid/engine e2e` (the Parquet case loads the
   extension from this folder) and `pnpm --filter @glassgrid/web e2e` must
   pass: the start-up log must say `parquet: true`.

// DuckDB-WASM's builds as asset URLs. Vite copies them into the build output
// (about 36 MB each, served as application/wasm; compress them on the host).
import ehUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import mvpUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';

export const DEFAULT_DUCKDB_BUNDLES = { eh: ehUrl, mvp: mvpUrl };

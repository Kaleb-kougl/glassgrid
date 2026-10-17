# Glassgrid

Open multi-gigabyte CSV files locally, browse them in a virtualized grid and
chart them. Glassgrid is an Electron desktop app with [DuckDB](https://duckdb.org)
as its embedded engine; nothing leaves your machine.

> Status: **M0 (spike and scaffold)**. The app opens a CSV and counts its rows
> through the full engine pipeline. See [docs/m0-notes.md](docs/m0-notes.md).

## Layout

| Path | What |
| --- | --- |
| `apps/desktop` | Electron app: main, preload, React renderer, DuckDB engine (utility process) |
| `apps/web` | Browser build (DuckDB-WASM), placeholder for now |
| `packages/core` | Platform-neutral TypeScript: types, Zod schemas, protocols, SQL |
| `packages/ui` | Shared React components |

DuckDB (`@duckdb/node-api`) runs in an Electron `utilityProcess`. The renderer
talks to it over a dedicated `MessagePort`, and results come back as Apache
Arrow IPC bytes.

## Requirements

- Node.js 22.12+ (CI uses 24, see `.nvmrc`)
- pnpm 10 (`corepack enable` picks up the version from `package.json`)

## Commands

```sh
pnpm install
pnpm dev          # desktop app with hot reload
pnpm dev:web      # web placeholder
pnpm build        # build desktop (electron-vite) and web (vite)
pnpm lint         # ESLint, including the core/renderer boundary rules
pnpm typecheck    # tsc for every package and process
pnpm test         # Vitest unit tests
pnpm e2e          # build, then Playwright E2E on a generated 1M-row CSV
pnpm e2e:10m      # same with 10M rows
pnpm package      # electron-builder installer for the current OS (unsigned)
```

E2E writes a benchmark baseline to `apps/desktop/e2e-results/*.json`. On Linux
without a display, run it under `xvfb-run -a`. Set
`GLASSGRID_E2E_EXECUTABLE=<path to packaged binary>` to test a packaged build.

Electron downloads its binary on first use. If that step is interrupted, run
`pnpm --filter @glassgrid/desktop exec install-electron`.

## License

[MIT](LICENSE) © 2026 Kaleb Kougl

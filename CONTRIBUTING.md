# Contributing

Thanks for taking a look. Glassgrid is a personal project, but issues and
small pull requests are welcome.

## Setup

- **Requirements:** Node.js 22.12 or newer (`.nvmrc` pins 24) and pnpm 10.
  Run `corepack enable` and the version is taken from `package.json`.
- **Install and run:** `pnpm install`, then `pnpm dev` for the desktop app
  or `pnpm dev:web` for the web demo. The [README](README.md) lists every
  command.
- **First desktop run:** Electron downloads its binary on first use. If that
  is interrupted, run `pnpm --filter @glassgrid/desktop exec install-electron`.

## Before you open a pull request

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm e2e        # desktop E2E on a generated 1M-row CSV (Linux without a display: xvfb-run -a pnpm e2e)
pnpm e2e:web    # web demo in Chromium
```

- **CI runs all of the above.** It also runs the desktop E2E on macOS,
  Windows and Linux (`.github/workflows/ci.yml`). Pull requests get a
  Vercel preview of the web demo.
- **Dependency changes:** if a pull request changes production
  dependencies, run `node scripts/third-party-notices.js` and commit the
  updated `THIRD_PARTY_NOTICES.md`. CI checks that it is current.

## Where things are

- The architecture and the reasoning behind it:
  [docs/technical-design.md](docs/technical-design.md).
- Per-milestone notes and benchmark results: the `docs/m*-*.md` files and
  `docs/benchmarks/`.
- `packages/core` is platform-neutral. ESLint enforces the
  boundary rules: no Node, Electron or DOM imports there.

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).

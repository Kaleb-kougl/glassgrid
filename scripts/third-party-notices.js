// @ts-check
/*
 * Generates THIRD_PARTY_NOTICES.md from the dependency tree that ships:
 *
 * - the web demo (apps/web `dependencies`, bundled by Vite), and
 * - the desktop app (apps/desktop `dependencies`, kept external and packaged
 *   by electron-builder, plus the devDependencies electron-vite bundles into
 *   main, preload and renderer; see apps/desktop/electron.vite.config.ts).
 *
 * Workspace packages (@glassgrid/*) are walked through, not listed. Optional
 * dependencies (DuckDB's per-platform native bindings) are listed by their
 * parent only, so the output is the same on every OS.
 *
 *   node scripts/third-party-notices.js          # rewrite THIRD_PARTY_NOTICES.md
 *   node scripts/third-party-notices.js --check  # exit 1 if it is out of date (CI)
 *
 * Needs `pnpm install` first: it reads licence fields from node_modules.
 */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, 'THIRD_PARTY_NOTICES.md');

/** devDependencies of apps/desktop that electron-vite bundles into the app. */
const DESKTOP_BUNDLED = ['@glassgrid/app', '@glassgrid/core', '@glassgrid/engine', '@glassgrid/ui', 'apache-arrow', 'react', 'react-dom', 'zod'];

/** @param {string} dir */
function readManifest(dir) {
  return /** @type {Record<string, any>} */ (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')));
}

/** Node's lookup: `<ancestor>/node_modules/<name>` for each ancestor of the package's real path. */
function resolvePackage(/** @type {string} */ fromDir, /** @type {string} */ name) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    if (basename(dir) !== 'node_modules') {
      const candidate = join(dir, 'node_modules', name);
      if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
    }
    if (dirname(dir) === dir) return null;
  }
}

function repositoryUrl(/** @type {Record<string, any>} */ manifest) {
  const repo = manifest['repository'];
  let url = typeof repo === 'string' ? repo : repo?.url;
  if (typeof url !== 'string') return typeof manifest['homepage'] === 'string' ? manifest['homepage'] : '';
  url = url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/^git@([^:]+):/, 'https://$1/');
  if (/^github:/.test(url)) url = url.replace(/^github:/, 'https://github.com/');
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) url = `https://github.com/${url}`;
  return url;
}

function licenseOf(/** @type {Record<string, any>} */ manifest) {
  const license = manifest['license'] ?? manifest['licenses'];
  if (typeof license === 'string') return license;
  if (Array.isArray(license)) return license.map((entry) => (typeof entry === 'string' ? entry : entry.type)).join(' OR ');
  if (license && typeof license === 'object') return String(license.type);
  return 'UNKNOWN';
}

/** @type {Map<string, { name: string, version: string, license: string, url: string, usedBy: Set<string> }>} */
const packages = new Map();

function walk(/** @type {string} */ dir, /** @type {string} */ app, /** @type {Set<string>} */ seen) {
  if (seen.has(dir)) return;
  seen.add(dir);
  const manifest = readManifest(dir);
  const name = String(manifest['name']);
  if (!name.startsWith('@glassgrid/')) {
    const key = `${name}@${String(manifest['version'])}`;
    const entry = packages.get(key) ?? { name, version: String(manifest['version']), license: licenseOf(manifest), url: repositoryUrl(manifest), usedBy: new Set() };
    entry.usedBy.add(app);
    packages.set(key, entry);
  }
  for (const dep of Object.keys(manifest['dependencies'] ?? {})) {
    const resolved = resolvePackage(dir, dep);
    if (!resolved) throw new Error(`${name}: dependency ${dep} is not installed (run pnpm install)`);
    walk(resolved, app, seen);
  }
}

const web = join(ROOT, 'apps/web');
const desktop = join(ROOT, 'apps/desktop');
const webSeen = new Set([web]);
for (const dep of Object.keys(readManifest(web)['dependencies'] ?? {})) {
  const resolved = resolvePackage(web, dep);
  if (!resolved) throw new Error(`apps/web: ${dep} is not installed`);
  walk(resolved, 'web', webSeen);
}
const desktopSeen = new Set([desktop]);
for (const dep of [...Object.keys(readManifest(desktop)['dependencies'] ?? {}), ...DESKTOP_BUNDLED]) {
  const resolved = resolvePackage(desktop, dep);
  if (!resolved) throw new Error(`apps/desktop: ${dep} is not installed`);
  walk(resolved, 'desktop', desktopSeen);
}

const rows = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
const byLicense = new Map();
for (const row of rows) byLicense.set(row.license, (byLicense.get(row.license) ?? 0) + 1);
const summary = [...byLicense.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([license, count]) => `${license} (${count})`).join(', ');

const markdown = `# Third-party notices

Glassgrid is MIT-licensed ([LICENSE](LICENSE)). It ships, or builds into its
web demo and desktop app, the third-party software below. Each item remains
under its own licence; the licence texts are in the linked repositories and
in each package under \`node_modules/\` after \`pnpm install\`.

## Files committed to this repository

| What | Where | Licence |
| --- | --- | --- |
| DuckDB Parquet extension v1.4.3 (\`wasm_eh\`, \`wasm_mvp\`), unmodified signed builds from extensions.duckdb.org | \`apps/web/public/duckdb-extensions/\` ([README](apps/web/public/duckdb-extensions/README.md)) | MIT, © Stichting DuckDB Foundation ([LICENSE](https://github.com/duckdb/duckdb/blob/main/LICENSE)) |
| Sample datasets (taxi trips, retail orders, sensor readings) | \`apps/web/public/samples/\` | Synthetic, generated by \`tools/datasets\` from seeded SQL; part of this project (MIT). No third-party data. |
| Design tokens and screenshots | \`packages/ui/tokens/\`, \`docs/design/\`, \`docs/images/\` | This project's own design work (MIT). |

## Bundled at build time

- **DuckDB-WASM** (\`@duckdb/duckdb-wasm\`, MIT): its JavaScript and
  WebAssembly builds are emitted into the web demo's \`dist/assets/\`. DuckDB
  itself is MIT; DuckDB's repository lists the third-party code compiled
  into it.
- **DuckDB native** (\`@duckdb/node-api\`, \`@duckdb/node-bindings\` and the
  per-platform \`@duckdb/node-bindings-<os>-<arch>\` package, all MIT) is
  packaged with the desktop app.
- **IBM Plex Sans and IBM Plex Mono** (via \`@fontsource/ibm-plex-sans\` and
  \`@fontsource/ibm-plex-mono\`): SIL Open Font License 1.1, © IBM Corp. The
  font files are bundled unmodified.
- **Electron** (MIT) is the desktop runtime. Packaged builds carry Electron's
  \`LICENSE.electron.txt\` and Chromium's \`LICENSES.chromium.html\`, which
  electron-builder adds next to the executable.

## npm packages

Generated by \`node scripts/third-party-notices.js\` from the installed
production dependency tree of \`apps/web\` and \`apps/desktop\` (including the
desktop devDependencies that electron-vite bundles). Development-only tools
(TypeScript, Vite, Vitest, Playwright, ESLint, electron-builder) are not
distributed and are not listed. The web build deduplicates \`apache-arrow\`
to one copy (version 21).

Licences: ${summary}.

| Package | Version | Licence | Used by | Source |
| --- | --- | --- | --- | --- |
${rows.map((row) => `| ${row.name} | ${row.version} | ${row.license} | ${[...row.usedBy].sort().reverse().join(', ')} | ${row.url} |`).join('\n')}
`;

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (current !== markdown) {
    console.error('THIRD_PARTY_NOTICES.md is out of date: run `node scripts/third-party-notices.js` and commit the result.');
    process.exit(1);
  }
  console.info(`THIRD_PARTY_NOTICES.md is up to date (${rows.length} packages).`);
} else {
  writeFileSync(OUT, markdown);
  console.info(`Wrote THIRD_PARTY_NOTICES.md (${rows.length} packages: ${summary}).`);
}

# Publishing: GitHub and Vercel

The steps to put Glassgrid on GitHub and deploy the web demo to Vercel, in
order. Nothing here has been done yet. Each step says where to click and
what you should see. Hosting details (headers, CSP, how samples load) are in
[m4-web-demo.md](m4-web-demo.md#deploying-vercel).

| | |
| --- | --- |
| Repository | `github.com/Kaleb-kougl/glassgrid` (public) |
| Push size | About 45 MB (`main`'s full history as one pack). The largest file is `apps/web/public/samples/taxi-trips-2025h1.parquet` at 20.8 MB, below GitHub's 50 MB warning. Git LFS is not needed. |
| Web demo | `apps/web`, a static Vite build, on Vercel |
| CI | `.github/workflows/ci.yml`: checks on Ubuntu, then desktop E2E on macOS, Windows and Ubuntu |

## 0. Before pushing

From the repository root on `main`:

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
node scripts/third-party-notices.js --check
git status   # clean
```

- **Commit metadata goes public.** Every commit's author is
  `Kaleb Kougl <kalebkougl@gmail.com>`. Most commits also carry the trailers
  `Co-Authored-By: Claude …` and `Claude-Session: https://claude.ai/code/session_…`.
  The session link only opens for your account.
- **Email privacy setting.** Check GitHub → Settings → Emails. If **Block
  command line pushes that expose my email** is on, the push is rejected
  (`GH007`). Either turn it off for this push, or rewrite the author email
  to your `…@users.noreply.github.com` address first. That rewrite is a
  history rewrite, so it changes every SHA. Do it before the first push or
  not at all.

## 1. Create the GitHub repository

1. Go to <https://github.com/new>.
   - **Owner**: `Kaleb-kougl`. **Repository name**: `glassgrid`.
   - **Description**: "Open multi-GB CSV files locally, browse them in a
     virtualized grid and chart them. Powered by DuckDB."
   - **Public**.
   - Leave **Add a README**, **.gitignore** and **license** all unset. The
     repository already has them, and an initial commit on GitHub would make
     the first push fail as non-fast-forward.
2. Click **Create repository**.
3. Push `main` only. Local working branches (`pres-*`) stay local.

   ```sh
   git remote add origin https://github.com/Kaleb-kougl/glassgrid.git
   git push -u origin main
   ```

   Expect "Writing objects: 100% … ~43 MiB". On a slow connection, if the
   push stalls on HTTPS, run `git config http.postBuffer 157286400` and
   push again.

## 2. Configure the repository

On the repository page:

- **About** (the gear icon, right column): set the description, set
  **Website** to the Vercel URL once step 4 is done, and add the topics
  `duckdb`, `electron`, `react`, `typescript`, `data-visualization`,
  `webassembly`, `csv` and `parquet`.
- **Settings → Code security**: for a public repository, **Secret scanning**
  and **Push protection** are on by default. Leave them on. Also turn on
  **Private vulnerability reporting**, which `SECURITY.md` points to, and
  **Dependabot alerts**. `.github/dependabot.yml` already opens one grouped
  PR a month for the SHA-pinned GitHub Actions.
- **Settings → Branches → Add branch ruleset** (optional; do it after the
  first CI run so the check names exist):
  - target `main`;
  - require a pull request;
  - require the status checks **Lint, typecheck, unit tests** and
    **Build + E2E (ubuntu-latest)**, and **Vercel** after step 4.

## 3. The first GitHub Actions run

The push to `main` starts **CI** (Actions tab). Workflows are on by default
for a new public repository. If Actions shows a banner, enable it there.

| Job | Runner | What it does | First run (cold caches) |
| --- | --- | --- | --- |
| **Lint, typecheck, unit tests** | ubuntu-latest | install, lint, typecheck, Vitest, notices check; installs Playwright's Chromium (cached afterwards); engine worker in Chromium; web build and budget; web E2E against `vercel.json`'s headers | about 10 to 15 min |
| **Build + E2E (macos-latest / windows-latest / ubuntu-latest)** | the three OSes, after the first job | downloads Electron (cached), `pnpm build`, desktop E2E on a generated 1M-row CSV, `electron-builder --dir`, the same E2E against the packaged app | about 15 to 30 min each; Windows is the slowest |

- Each E2E job uploads `benchmark-<os>`: the timing JSON for that OS.
- On failure it also uploads `playwright-report-<os>` (the report and the
  traces). For the first job it uploads `browser-test-results`.
- **Not yet run on macOS or Windows CI.** The whole suite passes on Linux,
  and macOS and Windows are covered by code paths (shortcuts, paths,
  packaging layout). The first run is the real test there. If one OS fails:
  1. Download its report artifact.
  2. Fix the problem on a branch, open a PR, and let CI run on it.
  3. As a last resort, mark that matrix entry `continue-on-error: true`
     while you investigate. The matrix already has `fail-fast: false`, so
     the other OSes finish either way.
- **workflow_dispatch**: Actions → CI → **Run workflow**. It takes a `rows`
  input, for example `10000000` for the 10M-row E2E.

README badge, once the workflow has run once:

```md
[![CI](https://github.com/Kaleb-kougl/glassgrid/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Kaleb-kougl/glassgrid/actions/workflows/ci.yml)
```

## 4. Import into Vercel

1. Go to <https://vercel.com/new>. Under **Import Git Repository**, choose
   GitHub. The first time, Vercel asks you to install its GitHub app: allow
   it for `Kaleb-kougl/glassgrid` only. Then click **Import** next to
   `glassgrid`.
2. **Configure Project**:
   - **Project Name**: `glassgrid`. This gives the production URL
     `glassgrid.vercel.app` if the name is free, or a variant if not.
   - **Framework Preset**: **Other**. `apps/web/vercel.json` sets
     `"framework": null` itself. Do not pick Vite: the commands below come
     from `vercel.json`.
   - **Root Directory**: click **Edit** and choose `apps/web`.
     `vercel.json` lives there, and Vercel reads it only from the root
     directory.
   - **Build and Output Settings**: leave every override off. Vercel shows
     the values from `vercel.json`:
     - Install: `pnpm install --frozen-lockfile --filter @glassgrid/web...`.
       This installs the web app and its workspace packages, not Electron.
     - Build: `pnpm --filter @glassgrid/web build`.
     - Output: `dist`.
   - **Environment Variables**: none needed. Optionally add
     `ENABLE_EXPERIMENTAL_COREPACK` = `1`. Corepack then runs exactly
     `pnpm@10.34.7` from `package.json#packageManager`.
3. Click **Deploy**. Expected build log:
   - `Detected pnpm-lock.yaml 9 … generated by pnpm@10…`. Vercel reads
     `packageManager` from the repository root's `package.json`.
   - The install takes about 30 to 60 s.
   - `vite build` lists `duckdb-eh-*.wasm` (34 MB) and
     `duckdb-mvp-*.wasm` (39 MB).
   - The whole build takes about 1 to 2 minutes. No native DuckDB is built:
     the samples are committed.
4. After the first deploy, open **Settings**:
   - **Build and Deployment → Node.js Version**: **24.x**, to match
     `.nvmrc` and CI. 22.x also works. Redeploy if you change it.
   - **Build and Deployment → Root Directory**: keep **Include files
     outside the root directory in the Build Step** on (the default). The
     build needs `packages/*`, the lockfile and `patches/`.
   - **Build and Deployment → Ignored Build Step** (optional): choose
     **Custom** and enter the command below. It skips builds when nothing
     the web app depends on changed. Vercel's clone has enough history for
     `HEAD^`.

     ```sh
     git diff --quiet HEAD^ HEAD -- . ../../packages ../../package.json ../../pnpm-lock.yaml ../../pnpm-workspace.yaml ../../patches
     ```

## 5. Preview deployments per PR

These are on by default with the Git integration. Every push to a branch
with an open PR builds a preview at its own URL, the Vercel bot comments the
link on the PR, and the deployment shows up as a **Vercel** status check.

- **Settings → Git**: keep **Pull Request Comments** on.
- **Settings → Deployment Protection**: **Vercel Authentication** (Standard
  Protection) is on by default, so previews ask visitors to log in to
  Vercel. Production is public.
  - To let reviewers or recruiters open previews, set it to **Only
    Production Deployments**, or **Disabled**.
  - Or keep it on and create a **Protection Bypass for Automation** secret
    for the check script (step 7).

## 6. Custom domain (optional)

**Settings → Domains → Add**, for example `glassgrid.dev` or
`demo.<yours>`. Then follow the DNS records Vercel shows: an `A` record for
an apex domain, a `CNAME` to `cname.vercel-dns.com` for a subdomain.

Nothing in the app or the CSP names a host: every request is same-origin.
Nothing else needs to change.

## 7. Check the deployment

```sh
scripts/check-deploy.sh https://glassgrid.vercel.app
# preview behind Deployment Protection:
VERCEL_PROTECTION_BYPASS=<secret> scripts/check-deploy.sh https://glassgrid-<hash>-<team>.vercel.app
```

It needs only bash and curl, and it checks:

- `/`, `/?sample=taxi` and `/gallery` return 200 with the same SPA shell and
  the header CSP: `'wasm-unsafe-eval'`, no `'unsafe-eval'`,
  `frame-ancestors 'none'`, plus `nosniff` and COOP.
- DuckDB's `duckdb-eh-*.wasm`, found by following the scripts from
  `index.html`, is `application/wasm`, `immutable`, and **compressed**
  (`content-encoding: br` or `gzip`).
- The Parquet extension is served as `application/wasm`.
- `/samples/taxi.glassgrid` is a workspace file.
- The taxi Parquet answers `Range: bytes=0-3` with `206` and `PAR1`.

It exits 1 on any failure.

**If the compression check fails** (uncertain until the first deploy):

- Vercel's CDN compresses responses by content type, and `application/wasm`
  should be on its list, so this is expected to pass. It has not been
  verified on a live deployment.
- If it fails, the first visit downloads 34 MB of WebAssembly instead of
  about 8 MB. The demo still works.
- The fix is a build step that writes Brotli-precompressed copies. Options
  are in [m4-web-demo.md](m4-web-demo.md#deploying-vercel).

Then open these by hand:

- `https://<deployment>/?sample=taxi`, `?sample=retail` and
  `?sample=sensors` in Chrome, Firefox and Safari;
- [the manual checklist](m4-web-demo.md#firefox-and-safari).

Put the URL in the repository's **About → Website** and in the README.

## Limits worth knowing

- **Vercel Hobby** is for non-commercial use, which a portfolio demo is.
  Its monthly transfer allowance is about 100 GB.
  - A cold visit that opens one sample transfers about 10 MB (compressed
    WebAssembly) + 2 MB (JS) + 8 to 21 MB (Parquet), so roughly 20 to 30 MB.
  - Repeat visits hit the browser cache: WebAssembly, assets and samples
    are `immutable`.
- **Changing a sample** adds its full size to git history (8 to 21 MB per
  file). Regenerate rarely. Keep the file name versioned, because the
  samples are cached as immutable.

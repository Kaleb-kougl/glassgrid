# Publishing: GitHub, releases and the portfolio

The steps to put Glassgrid on GitHub and get the web demo onto the
portfolio site, in order. Nothing here has been done yet. Each step says
where to click and what you should see.

The web demo has no Vercel project of its own. It is served as a static
subfolder of the portfolio, a Next.js app on Vercel, at
<https://kalebkougl-portfolio.vercel.app/glassgrid/>. Glassgrid builds,
tests and publishes a versioned tarball as a GitHub Release; the portfolio
pins a version and downloads that tarball when it builds. Hosting details
(headers, CSP, how samples load) are in
[m4-web-demo.md](m4-web-demo.md#hosting).

| | |
| --- | --- |
| Repository | `github.com/Kaleb-kougl/glassgrid` (public) |
| Push size | About 45 MB (`main`'s full history as one pack). The largest file is `apps/web/public/samples/taxi-trips-2025h1.parquet` at 20.8 MB, below GitHub's 50 MB warning. Git LFS is not needed. |
| CI | `.github/workflows/ci.yml`: checks on Ubuntu, then desktop E2E on macOS, Windows and Ubuntu |
| Web release | `.github/workflows/release-web.yml`, on a `web-vX.Y.Z` tag: `glassgrid-web-X.Y.Z.tar.gz` and its `.sha256` on a GitHub Release |
| Web demo | `https://kalebkougl-portfolio.vercel.app/glassgrid/`, from the portfolio repository `Kaleb-kougl/sswe-portfolio` |

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
   - **Public**. The portfolio downloads release assets without a token,
     which only works for a public repository.
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
  **Website** to `https://kalebkougl-portfolio.vercel.app/glassgrid/` once
  step 7 passes, and add the topics `duckdb`, `electron`, `react`,
  `typescript`, `data-visualization`, `webassembly`, `csv` and `parquet`.
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
    **Build + E2E (ubuntu-latest)**.
- **Settings → Rules → Rulesets → New tag ruleset** (optional): target
  `web-v*` and restrict deletions and updates, so a released version can
  never point at another commit.

## 3. The first GitHub Actions run

The push to `main` starts **CI** (Actions tab). Workflows are on by default
for a new public repository. If Actions shows a banner, enable it there.

| Job | Runner | What it does | First run (cold caches) |
| --- | --- | --- | --- |
| **Lint, typecheck, unit tests** | ubuntu-latest | install, lint, typecheck, Vitest, notices check; installs Playwright's Chromium (cached afterwards); engine worker in Chromium; web build and budget; web E2E at the root against `vercel.json`'s headers, then on a `/glassgrid/` build against `glassgrid-hosting.json`'s | about 10 to 15 min |
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

## 4. How the demo reaches the portfolio

```
glassgrid                                     GitHub Release web-vX.Y.Z               sswe-portfolio (Next.js on Vercel)
─────────                                     ─────────────────────────               ──────────────────────────────────
tag web-vX.Y.Z ─▶ release-web.yml             glassgrid-web-X.Y.Z.tar.gz              pins X.Y.Z + sha256
  build with GLASSGRID_BASE=/glassgrid/  ───▶ glassgrid-web-X.Y.Z.tar.gz.sha256  ───▶ build: download, verify, unpack into public/glassgrid/
  tests, budget, E2E under /glassgrid/                                                next.config: headers() + rewrites() from glassgrid-hosting.json
  repository_dispatch glassgrid-release  ─────────────────────────────────────────▶  (optional) a workflow bumps the pin
```

- **The build.** `GLASSGRID_BASE=/glassgrid/` makes Vite prefix every
  URL: scripts, the worker, DuckDB's `.wasm`, fonts, the samples, the
  Parquet extension and the gallery route
  (`/glassgrid/gallery`). Nothing is requested outside `/glassgrid/`; the
  E2E fails if anything is.
- **The tarball** holds the build at its root: `index.html`, `assets/`,
  `samples/`, `duckdb-extensions/` and `glassgrid-hosting.json`, about
  59 MB compressed and 123 MB unpacked (two DuckDB `.wasm` builds of 34 and
  39 MB, 40 MB of samples). Unpacked into the portfolio's
  `public/glassgrid/`, Next.js serves each file at `/glassgrid/<path>`.
- **`glassgrid-hosting.json`** carries what the portfolio's
  `next.config` must apply, generated from `apps/web/hosting.ts` (the same
  rules as `apps/web/vercel.json`):
  - `name`, `version`, `base` (`/glassgrid/`);
  - `headers`: Next.js `headers()` entries, general to specific, for
    `/glassgrid/:path*` (CSP, `nosniff`, `Referrer-Policy`,
    `Permissions-Policy`, COOP, CORP, `max-age=0`),
    `/glassgrid/assets/:path*` and `/glassgrid/duckdb-extensions/:path*`
    (immutable), `/glassgrid/samples/:file(.*\\.parquet)`,
    `/glassgrid/samples/:file(.*\\.glassgrid)` and
    `/glassgrid/:file(.*\\.wasm)` (content types);
  - `rewrites`: `/glassgrid`, `/glassgrid/`, `/glassgrid/gallery` and
    `/glassgrid/gallery/` to `/glassgrid/index.html`. Next.js serves a
    `public/` file only at its own path, never as a folder's index.
- **What the portfolio has to do** (in its own repository, not here):
  - download the pinned URL and check its sha256 before unpacking;
  - append the manifest's `headers` after its own rules: when several
    rules match, the later one wins for the same header, so a site-wide
    rule placed after them would replace the demo's CSP;
  - add the `rewrites` (as an array, or under `afterFiles`);
  - keep `trailingSlash` at its default (`false`). Next.js then answers
    `/glassgrid/` with a 308 to `/glassgrid`, and the header sources are
    written for that. With `trailingSlash: true` the page at
    `/glassgrid/` would get none of the headers;
  - not run its own middleware or proxy on `/glassgrid/` paths if that
    sets a CSP or other security headers.

## 5. Cut a release

1. Make sure CI is green on the commit to release.
2. Tag it and push the tag:

   ```sh
   git tag -a web-v0.1.0 -m "Web demo 0.1.0"
   git push origin web-v0.1.0
   ```

3. **Release web demo** starts (Actions tab). Not yet timed on GitHub; the
   checks job in CI, which does about the same work, takes 10 to 15 minutes
   cold:
   - install, lint, typecheck, unit tests, notices check;
   - build for `/glassgrid/` with version `0.1.0` and check the first-load
     budget;
   - the web E2E on that build, served the way Next.js will serve it;
   - `scripts/package-web.sh` packs the tested `dist/`;
   - `gh release create web-v0.1.0` with `glassgrid-web-0.1.0.tar.gz` and
     `glassgrid-web-0.1.0.tar.gz.sha256`;
   - the portfolio dispatch (step 6), or a notice that it was skipped.
4. The release page shows both files. The download URL is
   `https://github.com/Kaleb-kougl/glassgrid/releases/download/web-v0.1.0/glassgrid-web-0.1.0.tar.gz`.

- **Versions.** `X.Y.Z`, or `X.Y.Z-pre` (marked as a pre-release). The
  version comes from the tag, not from `apps/web/package.json`. Never move
  or re-push a tag: the portfolio pins the tarball by URL and sha256.
- **Dry run.** Actions → Release web demo → **Run workflow** with a version.
  It builds, tests and packages, and uploads the tarball as a workflow
  artifact. It creates no release and sends no dispatch.
- **Locally.** `pnpm package:web 0.1.0` builds for `/glassgrid/` and writes
  the tarball and `.sha256` to `apps/web/release/` (gitignored).
  `GLASSGRID_BASE=/glassgrid/ pnpm e2e:web` runs the web E2E on such a
  build. To try it in the portfolio before releasing, unpack the local
  tarball into its `public/glassgrid/` by hand.

## 6. Tell the portfolio (optional)

With the repository secret `PORTFOLIO_DISPATCH_TOKEN`, the release workflow
sends a `repository_dispatch` to `Kaleb-kougl/sswe-portfolio`:

```json
{
  "event_type": "glassgrid-release",
  "client_payload": {
    "version": "0.1.0",
    "url": "https://github.com/Kaleb-kougl/glassgrid/releases/download/web-v0.1.0/glassgrid-web-0.1.0.tar.gz",
    "sha256": "<64 hex digits>"
  }
}
```

A workflow in the portfolio with `on: repository_dispatch: types:
[glassgrid-release]` can then update its pin and open a PR. That workflow
lives in the portfolio repository.

**The token:**

1. GitHub → Settings → Developer settings → Personal access tokens →
   **Fine-grained tokens** → **Generate new token**.
2. **Resource owner**: `Kaleb-kougl`. **Expiration**: up to a year; note
   the date, the dispatch fails once it expires.
3. **Repository access**: **Only select repositories** →
   `sswe-portfolio`. Nothing else.
4. **Repository permissions** → **Contents**: **Read and write**
   (`repository_dispatch` needs it). Leave every other permission at
   **No access**.
5. Generate, copy, then in **glassgrid** → Settings → Secrets and variables
   → Actions → **New repository secret**: name `PORTFOLIO_DISPATCH_TOKEN`.

**Or leave it out.** The step is skipped with a notice, and you bump the
portfolio by hand: set the pinned version and paste the sha256 from the
release's `.sha256` file.

## 7. Check the deployment

After the portfolio has deployed the new version:

```sh
scripts/check-deploy.sh https://kalebkougl-portfolio.vercel.app/glassgrid/
# a portfolio preview behind Deployment Protection:
VERCEL_PROTECTION_BYPASS=<secret> scripts/check-deploy.sh https://<portfolio-preview>.vercel.app/glassgrid/
```

It needs only bash and curl. The base path comes from the URL (or a second
argument, or `GLASSGRID_BASE`). It checks:

- `/glassgrid/` (followed through the 308), `/glassgrid`,
  `/glassgrid/?sample=taxi` and `/glassgrid/gallery` return 200 with the
  same SPA shell, scripts from `/glassgrid/assets/`, and the header CSP:
  `'wasm-unsafe-eval'`, no `'unsafe-eval'`, `frame-ancestors 'none'`,
  plus `nosniff` and COOP.
- DuckDB's `duckdb-eh-*.wasm`, found by following the scripts from
  `index.html`, is `application/wasm`, `immutable`, and **compressed**
  (`content-encoding: br` or `gzip`).
- The Parquet extension is served as `application/wasm`.
- `/glassgrid/samples/taxi.glassgrid` is a workspace file.
- The taxi Parquet answers `Range: bytes=0-3` with `206` and `PAR1`.
- `/glassgrid/glassgrid-hosting.json` names the base, and its version is
  printed (a warning, not a failure, if the portfolio does not publish it).

It exits 1 on any failure.

**If the compression check fails** (uncertain until the first deploy):

- Vercel's CDN compresses responses by content type, and `application/wasm`
  should be on its list, so this is expected to pass. It has not been
  verified on a live deployment.
- If it fails, the first visit downloads 34 MB of WebAssembly instead of
  about 8 MB. The demo still works.
- The fix is a build step that writes Brotli-precompressed copies. Options
  are in [m4-web-demo.md](m4-web-demo.md#hosting).

Then open these by hand:

- `https://kalebkougl-portfolio.vercel.app/glassgrid/?sample=taxi`,
  `?sample=retail` and `?sample=sensors` in Chrome, Firefox and Safari;
- [the manual checklist](m4-web-demo.md#firefox-and-safari).

Put the URL in the repository's **About → Website** and drop the TODO note
from the README.

## Live flights

Shipping the live-flights demo ([live-flights.md](live-flights.md)) takes
both repositories: Glassgrid's `live-flights` branch (the map, the feed, the
L5 states, fallback and list view) and the portfolio's `live-flights-proxy`
branch (`GET /api/flights`, the relay of adsb.lol;
`docs/flights-proxy.md` there). Neither branch is pushed yet, and nothing
below has been done: it needs push and deploy credentials this environment
does not have. In order:

**1. Commit the L5 work** (it is in the working tree of `live-flights`, on
top of `d591c0f`), then run the gates once more:

```sh
git switch live-flights && git status          # the L5 files, nothing else
pnpm install --frozen-lockfile
pnpm lint && pnpm typecheck && pnpm test
pnpm e2e:web && GLASSGRID_BASE=/glassgrid/ pnpm e2e:web
pnpm --filter @glassgrid/web size              # first-load JS within 400 kB (276.9 kB at L5)
node scripts/third-party-notices.js --check
git add -A && git commit -m "Live flights L5: feed states, offline → replay, list view, showcase, docs"
```

**2. Push and merge the portfolio relay first**, so `/api/flights` exists
before a demo that polls it is deployed:

```sh
cd sswe-portfolio
git switch live-flights-proxy
git push -u origin live-flights-proxy
gh pr create --base main --head live-flights-proxy --title "/api/flights: a cached, same-origin relay of adsb.lol"
```

Vercel builds a preview of the PR. Check its route (step 6's commands,
against the preview URL; behind Deployment Protection add
`-H "x-vercel-protection-bypass: <secret>"`), then merge when CI is green.
The merge to `main` deploys production.

**3. Push and merge Glassgrid's branch:**

```sh
cd glassgrid
git push -u origin live-flights
gh pr create --base main --head live-flights --title "Live flights (L0–L5)"
```

Wait for **Lint, typecheck, unit tests** and the three **Build + E2E** jobs.
The new **Web E2E (Firefox, WebKit)** job is allowed to fail on its first
runs (`continue-on-error`). Look at its result anyway: green there is the
L5 gate "E2E green in Chromium, Firefox and WebKit on the replay source",
which this environment could not run. If it is green, delete
`continue-on-error: true` from the job in `.github/workflows/ci.yml`. Merge.

**4. Tag a web release** on the merge commit. The last release is
`web-v0.1.0`, which the portfolio pins now:

```sh
git switch main && git pull
git tag -a web-v0.2.0 -m "Web demo 0.2.0: live flights"
git push origin web-v0.2.0
```

`release-web.yml` builds for `/glassgrid/`, runs the gates and the E2E under
`/glassgrid/` (the flights specs included), and publishes
`glassgrid-web-0.2.0.tar.gz` and `.sha256` on the release (section 5 above).

**5. Bump the portfolio's pin and deploy.** With `PORTFOLIO_DISPATCH_TOKEN`
set, the release sends `glassgrid-release` and the portfolio's
`.github/workflows/bump-glassgrid.yml` opens the PR `glassgrid/v0.2.0` by
itself. Otherwise, either run Actions → Bump Glassgrid → Run workflow with
version `0.2.0` and the sha256 from the release's `.sha256`, or by hand:

```sh
cd sswe-portfolio && git switch main && git pull && git switch -c glassgrid/v0.2.0
# glassgrid.lock.json:
#   "version": "0.2.0",
#   "url": "https://github.com/Kaleb-kougl/glassgrid/releases/download/web-v0.2.0/glassgrid-web-0.2.0.tar.gz",
#   "sha256": "<the 64 hex digits in glassgrid-web-0.2.0.tar.gz.sha256>"
npm run glassgrid:fetch                       # scripts/fetch-glassgrid.mjs: downloads, checks the sha256, unpacks
npm run build                                  # next.config.ts validates public/glassgrid/glassgrid-hosting.json
git commit -am "Glassgrid 0.2.0" && git push -u origin glassgrid/v0.2.0 && gh pr create --base main
```

Merge the PR once its CI and Vercel preview pass; Vercel deploys production
from `main`. In Vercel → Deployments the production deployment shows
**Ready**. Then `scripts/check-deploy.sh
https://kalebkougl-portfolio.vercel.app/glassgrid/` (section 7) should still
pass, and print version 0.2.0.

**6. Check `/api/flights` on the deployed site.**

```sh
SITE=https://kalebkougl-portfolio.vercel.app
curl -sS -D /tmp/flights.headers -o /tmp/flights.json "$SITE/api/flights"
grep -iE '^(HTTP|content-type|cache-control|x-vercel-cache|x-flights-stale|retry-after)' /tmp/flights.headers
jq '{now, fetchedAt, stale, source, license, aircraft: (.ac | length), first: .ac[0]}' /tmp/flights.json
```

Expected: `HTTP/2 200`, `content-type: application/json`, a body with
`now` and `fetchedAt` in epoch **milliseconds** within a few seconds of
each other, `stale: false`, `source: "adsb.lol"`, the ODbL licence URL, and
tens of aircraft (over 100 in the Bay Area's afternoon; the recorded day
peaked at 183), each with `hex`, `lat`, `lon` and most of `flight`,
`alt_baro`, `gs`, `track`, `t`, `r`. `cache-control` is the route's
`public, s-maxage=10, stale-while-revalidate=20` or Vercel's rewrite of it
for the browser; either is fine. A `503` with `{"reason": ...}` and
`Retry-After` means the relay has no data: its `reason` says why
(`docs/flights-proxy.md` in the portfolio; the first call after a cold start
can take up to 45 s of TLS handshake to adsb.lol).

The CDN in front of it, one request every 4 s for half a minute:

```sh
for i in $(seq 1 8); do curl -sS -o /dev/null -D - "$SITE/api/flights" | grep -iE '^(x-vercel-cache|age):' | tr '\r\n' '  '; echo; sleep 4; done
```

Expected: `MISS` first (the function ran), then `HIT` with a growing `age`
while the copy is under 10 s old, then `STALE` (served from the CDN while
one request refreshes it) or `MISS` again, then `HIT`s again. A `503` is
`no-store` and is never a `HIT`.

One upstream call per 10 s: `fetchedAt` is when the instance called
adsb.lol, so poll past the CDN (a query string misses the CDN's cache, the
route ignores it) once a second for a minute and count the distinct values:

```sh
for i in $(seq 1 60); do curl -sS "$SITE/api/flights?check=$i" | jq -r .fetchedAt; sleep 1; done | sort -u | wc -l
```

Expected: 6 or 7 (one per 10 s window). More means several function
instances (each holds its own snapshot), not a bug in the relay. In Vercel
→ the deployment → **Logs**, filtered to `/api/flights`: the route logs one
JSON line per **failed** upstream call
(`{"route":"/api/flights","upstream":…,"reason":…,"retryInMs":…}`) and
nothing for successful ones; with only the plain URL polled (no query
string), invocations come at most about once per 10 s.

**7. Check `?live=1` on the deployed demo.** Open
`https://kalebkougl-portfolio.vercel.app/glassgrid/?live=1` in Chrome, then
Firefox and Safari:

- the map card says "Connecting to the live feed…", then "Live · N
  aircraft" within 20 s (a cold relay: up to about 50 s); the top bar says
  "N rows · Live";
- the attribution shows the relay's "Aircraft data © adsb.lol contributors,
  ODbL 1.0" before the basemap's credits;
- DevTools → Network: `/api/flights` once every 20 s, `200`; Console: no
  CSP violation or error;
- DevTools → Network: once the card says "Live", a request for
  `samples/flights/flights-bay-30min.parquet` (0.76 MB) has gone out: the
  recording, fetched ahead into memory;
- then DevTools → Network → **Offline**: the status line says "Offline ·
  retrying in N s" (counting down) and the strip offers "Watch the recorded
  traffic instead". Click it: the strip says "Loading the recorded
  traffic…", then "Showing recorded traffic … You are offline.", and the
  half hour plays, still offline (it loads from memory). Back **online**
  (No throttling): the page probes `/api/flights` at once (at most once per
  10 s) and "Back to live" appears within a few seconds; click it: live
  again;
- (if the fixture request had failed, offline the strip says "The recorded
  traffic didn't load … It will try again when you are back online", and
  back online it loads by itself;)
- "List view" under the map: the aircraft in view, by callsign;
  `?sample=flights` works too.

**8. Run the GPU benchmarks on a real machine** (the targets were set for
one; this VM has no GPU) and update the README's Numbers:

```sh
pnpm install --frozen-lockfile
pnpm --filter @glassgrid/web exec playwright install chromium
pnpm --filter @glassgrid/web build
GLASSGRID_E2E_FLIGHTS_PERF=1 pnpm --filter @glassgrid/web exec playwright test e2e/flights-perf.spec.ts   # brush, pan, seek → apps/web/e2e-results/flights-perf-chromium-<os>-<arch>.json
pnpm --filter @glassgrid/web e2e:map-perf                                                                 # map frame time → apps/web/e2e-results/map-perf-chromium-<os>-<arch>.json
```

Check that the map JSON's `renderer` names the GPU, not SwiftShader; if it
does not, add `--headed` to both commands. Both write to
`apps/web/e2e-results/`, which Playwright's next run does not empty (its
`test-results/` it does). Copy the JSON files to
`docs/benchmarks/l5/`, then replace the "brush p95" and "frame interval"
cells of the live-flights rows in `README.md` (and the Numbers table of
`docs/live-flights.md`) with the new values and that machine's conditions.

## Limits worth knowing

- **One origin with the portfolio.** The demo's headers apply only under
  `/glassgrid/`. Storage is per origin, so the portfolio's pages can see
  the demo's OPFS Parquet cache (folder `glassgrid/parquet`) and its theme
  override (`localStorage` key `glassgrid.theme`), and the other way round.
  Both names are prefixed, so they do not collide.
- **Vercel Hobby** is for non-commercial use, which a portfolio is. Its
  monthly transfer allowance is about 100 GB, shared with the rest of the
  portfolio.
  - A cold visit that opens one sample transfers about 10 MB (compressed
    WebAssembly) + 2 MB (JS) + 8 to 21 MB (Parquet), so roughly 20 to 30 MB.
  - Repeat visits hit the browser cache: WebAssembly, assets and samples
    are `immutable`.
- **The portfolio's deployment grows** by about 123 MB of static files per
  version it serves.
- **Changing a sample** adds its full size to git history (8 to 21 MB per
  file). Regenerate rarely. Keep the file name versioned, because the
  samples are cached as immutable.
- **A standalone deploy still works.** `apps/web/vercel.json` (generated
  from the same `hosting.ts`) builds the demo at a domain root, as a Vercel
  project with Root Directory `apps/web`, and `scripts/check-deploy.sh
  https://<project>.vercel.app` checks it. Nothing uses it now.

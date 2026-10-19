/**
 * `pnpm showcase`: rebuilds the web demo and the desktop app, then writes
 * every README and case-study image and video to docs/images/showcase/.
 *
 *   pnpm showcase                      # build, then capture everything
 *   pnpm showcase --skip-build         # reuse apps/web/dist and apps/desktop/out
 *   pnpm showcase --only web,video     # any of: web, video, desktop
 *
 * Needs Chromium (GLASSGRID_CHROMIUM or PLAYWRIGHT_BROWSERS_PATH; nothing is
 * downloaded), ffmpeg on PATH (or FFMPEG), and on Linux without a display,
 * xvfb-run for the desktop app. The desktop step generates the 10M-row
 * synthetic CSV with tools/datasets on its first run and keeps it in
 * tools/showcase/out/.
 *
 * Duration on a 2-vCPU Linux VM: 2 to 5 minutes depending on load (build
 * 10-20 s, web stills 30-45 s, demo video 1-2.5 min, desktop 30-60 s), plus
 * about 2 minutes on the first run to generate the CSV.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { writeArchitecture } from './architecture.ts';
import { checkLinks } from './check-links.ts';
import { ensureDir, log, MEDIA_DIR, REPO_ROOT, run, seconds } from './common.ts';
import { encodeDemo } from './encode.ts';
import { captureStills, captureVideoFrames } from './web.ts';

const STEPS = ['web', 'video', 'desktop'] as const;
type Step = (typeof STEPS)[number];
/** The README embeds the GIF; GitHub renders large GIFs slowly. */
const GIF_BUDGET_BYTES = 4 * 1024 * 1024;

const { values } = parseArgs({
  options: {
    'skip-build': { type: 'boolean', default: false },
    only: { type: 'string' },
  },
});
const only = new Set<Step>(
  (values.only ?? STEPS.join(','))
    .split(',')
    .map((step) => step.trim())
    .filter((step): step is Step => (STEPS as readonly string[]).includes(step)),
);

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolvePort(address.port);
        else reject(new Error('no port'));
      });
    });
  });
}

/** apps/web/e2e/serve.ts: dist/ with the production headers from vercel.json, Range and HEAD. */
async function serveWeb(): Promise<{ baseUrl: string; server: ChildProcess }> {
  const port = await freePort();
  const server = spawn(process.execPath, [join(REPO_ROOT, 'apps', 'web', 'e2e', 'serve.ts'), String(port)], { stdio: ['ignore', 'ignore', 'inherit'] });
  const baseUrl = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(baseUrl)).ok) return { baseUrl, server };
    } catch {
      // Not listening yet.
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  server.kill();
  throw new Error('the web server did not start');
}

async function build(steps: Set<Step>): Promise<void> {
  if (steps.has('web') || steps.has('video')) await run('pnpm', ['--filter', '@glassgrid/web', 'build']);
  if (steps.has('desktop')) {
    await run('pnpm', ['--filter', '@glassgrid/desktop', 'build']);
    // Electron fetches its binary on first use; do it now rather than inside Playwright's launch.
    if (!existsSync(join(REPO_ROOT, 'apps', 'desktop', 'node_modules', 'electron', 'path.txt'))) {
      await run('pnpm', ['--filter', '@glassgrid/desktop', 'exec', 'install-electron']);
    }
  }
}

async function captureDesktop(): Promise<void> {
  const script = join(REPO_ROOT, 'tools', 'showcase', 'src', 'desktop.ts');
  if (process.platform === 'linux' && !process.env['DISPLAY']) {
    // The window is 1440x900 at device scale 2: give the virtual screen room for it.
    await run('xvfb-run', ['-a', '-s', '-screen 0 3200x2000x24', process.execPath, script]);
  } else {
    await run(process.execPath, [script]);
  }
}

function report(): void {
  const files = readdirSync(MEDIA_DIR).sort();
  const width = Math.max(...files.map((file) => file.length));
  let total = 0;
  for (const file of files) {
    const bytes = statSync(join(MEDIA_DIR, file)).size;
    total += bytes;
    console.info(`  ${file.padEnd(width)}  ${(bytes / 1024).toFixed(0).padStart(6)} KB`);
  }
  console.info(`  ${'total'.padEnd(width)}  ${(total / 1024).toFixed(0).padStart(6)} KB`);
}

async function main(): Promise<void> {
  const started = performance.now();
  if (!values['skip-build']) {
    const buildStarted = performance.now();
    await build(only);
    log(`build: ${seconds(buildStarted)}`);
  }
  await ensureDir(MEDIA_DIR);
  if (only.size === STEPS.length) {
    // A full run owns the folder: nothing stale survives a rename.
    await rm(MEDIA_DIR, { recursive: true, force: true });
    await ensureDir(MEDIA_DIR);
  }
  await writeArchitecture();

  if (only.has('web') || only.has('video')) {
    const { baseUrl, server } = await serveWeb();
    try {
      if (only.has('web')) {
        const stepStarted = performance.now();
        await captureStills(baseUrl);
        log(`web stills: ${seconds(stepStarted)}`);
      }
      if (only.has('video')) {
        const stepStarted = performance.now();
        const frames = await captureVideoFrames(baseUrl);
        const [gif] = await encodeDemo(frames, 'crossfilter-demo');
        if (gif && statSync(gif).size > GIF_BUDGET_BYTES) throw new Error(`crossfilter-demo.gif is ${(statSync(gif).size / 1e6).toFixed(1)} MB, over the 4 MB budget`);
        log(`video: ${seconds(stepStarted)}`);
      }
    } finally {
      server.kill();
    }
  }
  if (only.has('desktop')) {
    const stepStarted = performance.now();
    await captureDesktop();
    log(`desktop: ${seconds(stepStarted)}`);
  }

  log('docs/images/showcase/:');
  report();
  const problems = checkLinks();
  if (problems.length > 0) throw new Error(`broken links or images:\n${problems.join('\n')}`);
  log(`done in ${seconds(started)}`);
}

await main();

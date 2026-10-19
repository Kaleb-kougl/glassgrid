/**
 * The README's architecture diagram as built after M4 (docs/images/showcase/architecture.svg).
 * docs/images/architecture.png is the design-time picture of the whole
 * project (v1 and v2, exported from the design doc); this one draws only
 * what exists in the repository, by package.
 *
 *   node tools/showcase/src/architecture.ts
 */
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(resolve(import.meta.dirname, '..', '..', '..'), 'docs', 'images', 'showcase', 'architecture.svg');

const W = 1200;
const H = 910;
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
const C = {
  ink: '#1f2328',
  muted: '#59636e',
  line: '#8c959f',
  group: '#f3f4f6',
  groupLine: '#d0d7de',
  box: '#ffffff',
  accent: '#0b5cad',
  accentFill: '#e8f1fb',
  shared: '#eef6ee',
  sharedLine: '#9cc59c',
};

const esc = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** Greedy word wrap at an approximate character budget (no text metrics in a static SVG). */
function wrap(text: string, chars: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line !== '' && line.length + 1 + word.length > chars) {
      lines.push(line);
      line = word;
    } else line = line === '' ? word : `${line} ${word}`;
  }
  if (line !== '') lines.push(line);
  return lines;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const parts: string[] = [];

function group(box: Box, label: string, options: { fill?: string; stroke?: string; dashed?: boolean } = {}): void {
  parts.push(
    `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="12" fill="${options.fill ?? C.group}" stroke="${options.stroke ?? C.groupLine}"${options.dashed ? ' stroke-dasharray="6 5"' : ''}/>`,
    `<text x="${box.x + 18}" y="${box.y + 28}" font-family="${FONT}" font-size="15" font-weight="600" fill="${C.ink}">${esc(label)}</text>`,
  );
}

function node(box: Box, title: string, lines: readonly string[], options: { accent?: boolean; mono?: string; dashed?: boolean } = {}): void {
  const fill = options.accent ? C.accentFill : C.box;
  const stroke = options.accent ? C.accent : C.groupLine;
  parts.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" rx="8" fill="${fill}" stroke="${stroke}"${options.accent ? ' stroke-width="1.5"' : ''}${options.dashed ? ' stroke-dasharray="6 5"' : ''}/>`);
  parts.push(`<text x="${box.x + 14}" y="${box.y + 24}" font-family="${FONT}" font-size="14" font-weight="600" fill="${C.ink}">${esc(title)}</text>`);
  let y = box.y + 24;
  if (options.mono) {
    y += 20;
    parts.push(`<text x="${box.x + 14}" y="${y}" font-family="${MONO}" font-size="12.5" fill="${C.accent}">${esc(options.mono)}</text>`);
  }
  const chars = Math.floor((box.w - 28) / 6.6);
  for (const text of lines) {
    for (const line of wrap(text, chars)) {
      y += 18;
      parts.push(`<text x="${box.x + 14}" y="${y}" font-family="${FONT}" font-size="12.5" fill="${C.muted}">${esc(line)}</text>`);
    }
  }
}

/** A vertical connector with arrow heads and a label to its right. */
function link(x: number, y1: number, y2: number, label: string, both = true): void {
  const head = (y: number, down: boolean) => `<path d="M${x - 5} ${down ? y - 8 : y + 8} L${x} ${y} L${x + 5} ${down ? y - 8 : y + 8}" fill="none" stroke="${C.line}" stroke-width="1.5"/>`;
  parts.push(`<line x1="${x}" y1="${y1}" x2="${x}" y2="${y2}" stroke="${C.line}" stroke-width="1.5"/>`, head(y2, true));
  if (both) parts.push(head(y1, false));
  parts.push(`<text x="${x + 10}" y="${(y1 + y2) / 2 + 4}" font-family="${FONT}" font-size="12.5" fill="${C.muted}">${esc(label)}</text>`);
}

function build(): string {
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<text x="40" y="44" font-family="${FONT}" font-size="20" font-weight="600" fill="${C.ink}">One app, one query engine, two runtimes</text>`);
  parts.push(
    `<text x="40" y="68" font-family="${FONT}" font-size="13.5" fill="${C.muted}">As built after M4. Every grid page and chart is a query; only screen-sized Arrow results cross into the UI.</text>`,
  );

  // Desktop
  group({ x: 40, y: 92, w: 545, h: 448 }, 'Desktop app · Electron (apps/desktop)');
  node({ x: 60, y: 134, w: 505, h: 74 }, 'Main process', ['Windows, menus and native dialogs; .glassgrid save, open and relink; autosave and crash recovery.']);
  node({ x: 60, y: 252, w: 505, h: 104 }, 'Renderer · sandboxed, CSP', ['The shared app on the desktop Platform. EngineClient: per-view sequencing, superseding, page coalescing.'], { accent: true, mono: '<App platform={desktop} />' });
  node({ x: 60, y: 404, w: 505, h: 116 }, 'Engine · utilityProcess', ['@duckdb/node-api 1.5.6: one locked-down DuckDB per table (allowlisted paths, no external access), spills to disk; Parquet cache in the app cache folder.'], {
    mono: 'QueryService + native driver',
  });
  link(150, 208, 252, 'preload API, Zod-validated IPC; file handles, never paths');
  link(150, 356, 404, 'MessagePort (wired by main) · specs in, Arrow IPC out');

  // Web
  group({ x: 615, y: 92, w: 545, h: 448 }, 'Web demo · static build (apps/web)');
  node({ x: 635, y: 134, w: 505, h: 74 }, 'Static host', ['App JS, DuckDB-WASM, the signed Parquet extension, three sample Parquet files with .glassgrid workspaces; production headers.']);
  node({ x: 635, y: 252, w: 505, h: 104 }, 'Page · main thread, header CSP', ['The same app on the web Platform. createWorkerEngine() implements the same EngineClientApi.'], { accent: true, mono: '<App platform={web} />' });
  node({ x: 635, y: 404, w: 505, h: 116 }, 'Engine · Web Worker', ['duckdb-wasm 1.32.0 (DuckDB 1.4.3), single-threaded; locked-down sandbox; Parquet cache in OPFS; 1 GiB memory limit.'], {
    mono: 'QueryService + DuckDB-WASM driver',
  });
  link(725, 208, 252, 'HTTP', false);
  link(725, 356, 404, 'postMessage · transferred Arrow buffers');
  // The worker reads samples itself, by HTTP range requests.
  parts.push(
    `<path d="M1120 404 L1120 208" fill="none" stroke="${C.line}" stroke-width="1.5" stroke-dasharray="4 4"/>`,
    `<path d="M1115 216 L1120 208 L1125 216" fill="none" stroke="${C.line}" stroke-width="1.5"/>`,
    `<text x="1110" y="234" font-family="${FONT}" font-size="12.5" fill="${C.muted}" text-anchor="end">worker: Range reads of samples</text>`,
  );

  // Shared packages
  group({ x: 40, y: 568, w: 1120, h: 232 }, 'Shared TypeScript packages: one contract for both runtimes', { fill: C.shared, stroke: C.sharedLine });
  const cols = [
    ['packages/core', 'No DOM, Node or React.', 'ChartSpec and Zod schemas, SQL compiler (bound parameters), cross-filter model, command registry and undo, .glassgrid format and migrations, protocols.'],
    ['packages/ui', 'Browser, React.', 'Canvas grid (1,000-row pages, scaled scrolling, ARIA mirror), Canvas 2D chart layer with a shared WebGL overlay, design tokens.'],
    ['packages/app', 'No Electron, Node or shell code.', 'The app: views, actions, workspace wiring. Each shell passes a Platform (engine, files, clipboard, window, capabilities).'],
    ['packages/engine', 'Core runs anywhere; drivers per runtime.', 'QueryService, top-K pages and row indexes, cross-filter cubes, result and Parquet caches, behind a DuckDriver interface (native or wasm).'],
  ] as const;
  cols.forEach(([title, rule, text], index) => {
    node({ x: 60 + index * 272, y: 610, w: 256, h: 172 }, title, [rule, text]);
  });

  // Not built yet
  node({ x: 40, y: 822, w: 548, h: 68 }, 'Next (M6): MCP bridge', ['A second caller of the same command registry, through the same validation and undo.'], { dashed: true });
  node({ x: 612, y: 822, w: 548, h: 68 }, 'Next (M5): signed installers, auto-update, public deploy', ['Not shipped yet; packaging is unsigned today.'], { dashed: true });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Glassgrid architecture after M4: the shared app and engine packages on Electron and in the browser">\n${parts.join('\n')}\n</svg>\n`;
}

export async function writeArchitecture(): Promise<string> {
  parts.length = 0;
  await writeFile(OUT, build());
  return OUT;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.info(`[showcase] wrote ${await writeArchitecture()}`);
}

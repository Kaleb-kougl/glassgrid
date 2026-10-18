import { readFileSync, writeFileSync } from 'node:fs';

/*
 * Medians over runs of the render benchmark (render-perf.spec.ts).
 *
 *   node apps/desktop/e2e/render-perf-medians.ts <out.json> <run1.json> <run2.json> …
 *
 * Runs are grouped by row count and build (instrumented or plain). Every
 * statistic (p50, p95, max, mean) is the median of that statistic over the
 * runs; component render counts and profile/trace hotspots are medians of the
 * per-run means. Also prints the Markdown tables of docs/render-perf-baseline.md.
 */

type Stats = { n: number; min: number; p50: number; p95: number; max: number; mean: number };
type StatsMap = Record<string, Stats>;
interface ComponentRow {
  name: string;
  renders: number;
  wasted: number;
  selfMs: number;
  causes: Record<string, number>;
  unstableProps: string[];
}
interface Group {
  n: number;
  measureMs?: Stats;
  engineMs?: Stats;
  totals?: StatsMap;
  milestones?: StatsMap;
  segments?: StatsMap;
  work?: StatsMap;
  commits?: StatsMap;
  after?: StatsMap;
  drag?: StatsMap;
  dragComponents?: ComponentRow[];
  regions?: Record<string, { ms: number; renders: number }>;
  components?: ComponentRow[];
}
interface ViewTiming {
  view: string;
  engineMs: number;
  request: number;
  reply: number | null;
  drawn: number | null;
  decodeMs: number;
}
interface Run {
  rows: number;
  instrumented: boolean;
  recordedAt: string;
  summary: {
    create: Record<string, Group>;
    brush: Group;
    brushStart: Group;
    select: Group;
    profiles: Record<string, { totalMs: number; byCategory: Record<string, number>; top: { function: string; module: string; selfMs: number }[] }>;
    traces: Record<string, { busyMs: number; byCategory: Record<string, number>; byEvent: { name: string; selfMs: number }[]; forced?: { styleMs: number; layoutMs: number; count: number } }>;
  };
  samples: {
    create: Record<string, { analysis?: { milestones: Record<string, number> } }[]>;
    brush: { analysis?: { views: ViewTiming[]; milestones: Record<string, number> } }[];
    select: { analysis?: { milestones: Record<string, number> } }[];
  };
}

// Segment chains: keep in step with createChain / INTERACTION_CHAIN in render-analysis.ts.
function createChain(milestones: Record<string, number>): string[] {
  const head = ['input', 'dispatch', 'notify', 'render', 'shell-commit-start', 'shell-commit-end', 'query', 'request', 'reply', 'validated', 'decoded', 'resolved', 'data-render', 'data-commit-start'];
  const drawnInData = milestones['draw-commit-start'] === undefined && (milestones['drawn'] ?? 0) <= (milestones['data-commit-end'] ?? -Infinity);
  const tail =
    milestones['draw-commit-start'] !== undefined
      ? ['data-commit-end', 'draw-commit-start', 'drawn', 'draw-commit-end']
      : drawnInData
        ? ['drawn', 'data-commit-end']
        : ['data-commit-end', 'drawn'];
  return [...head, ...tail, 'raf', 'presented'];
}
const INTERACTION_CHAIN = ['input', 'dispatch', 'notify', 'render', 'first-commit-start', 'first-commit-end', 'first-request', 'last-drawn', 'raf', 'presented'];

function segmentsOf(milestones: Record<string, number>, chain: readonly string[]): Record<string, number> {
  const present = chain.filter((name) => milestones[name] !== undefined);
  const segments: Record<string, number> = {};
  for (let i = 1; i < present.length; i += 1) {
    const a = present[i - 1] ?? '';
    const b = present[i] ?? '';
    segments[`${a}→${b}`] = (milestones[b] ?? 0) - (milestones[a] ?? 0);
  }
  return segments;
}

/** Nearest-rank stats, as e2e/support.ts `stats`. */
function statsOf(values: readonly number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN;
  return { n: sorted.length, min: sorted[0] ?? Number.NaN, p50: rank(0.5), p95: rank(0.95), max: sorted.at(-1) ?? Number.NaN, mean: sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length) };
}

/** Segment stats of one run's samples (re-derived from their milestones with the chains above). */
function segmentStats(samples: readonly { analysis?: { milestones: Record<string, number> } }[], chain: (milestones: Record<string, number>) => readonly string[]): StatsMap | undefined {
  const lists = new Map<string, number[]>();
  for (const sample of samples) {
    if (!sample.analysis) continue;
    for (const [segment, ms] of Object.entries(segmentsOf(sample.analysis.milestones, chain(sample.analysis.milestones)))) lists.set(segment, [...(lists.get(segment) ?? []), ms]);
  }
  if (lists.size === 0) return undefined;
  return Object.fromEntries([...lists].map(([segment, values]) => [segment, statsOf(values)]));
}

const median = (values: readonly number[]): number => {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] ?? Number.NaN) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
};

function medianStats(list: readonly (Stats | undefined)[]): Stats | undefined {
  const present = list.filter((stats): stats is Stats => stats !== undefined);
  if (present.length === 0) return undefined;
  return {
    n: median(present.map((s) => s.n)),
    min: median(present.map((s) => s.min)),
    p50: median(present.map((s) => s.p50)),
    p95: median(present.map((s) => s.p95)),
    max: median(present.map((s) => s.max)),
    mean: median(present.map((s) => s.mean)),
  };
}

function medianMap(list: readonly (StatsMap | undefined)[]): StatsMap | undefined {
  const present = list.filter((map): map is StatsMap => map !== undefined);
  if (present.length === 0) return undefined;
  const keys = [...new Set(present.flatMap((map) => Object.keys(map)))];
  const out: StatsMap = {};
  for (const key of keys) {
    const stats = medianStats(present.map((map) => map[key]));
    if (stats) out[key] = stats;
  }
  return out;
}

function medianComponents(list: readonly (ComponentRow[] | undefined)[]): ComponentRow[] {
  const present = list.filter((rows): rows is ComponentRow[] => rows !== undefined);
  const names = [...new Set(present.flatMap((rows) => rows.map((row) => row.name)))];
  return names
    .map((name) => {
      const rows = present.map((runRows) => runRows.find((row) => row.name === name));
      const pick = (f: (row: ComponentRow) => number) => median(rows.map((row) => (row ? f(row) : 0)));
      const causes = [...new Set(rows.flatMap((row) => Object.keys(row?.causes ?? {})))];
      return {
        name,
        renders: pick((row) => row.renders),
        wasted: pick((row) => row.wasted),
        selfMs: pick((row) => row.selfMs),
        causes: Object.fromEntries(causes.map((cause) => [cause, pick((row) => row.causes[cause] ?? 0)])),
        unstableProps: [...new Set(rows.flatMap((row) => row?.unstableProps ?? []))].slice(0, 6),
      };
    })
    .sort((a, b) => b.renders - a.renders || b.selfMs - a.selfMs);
}

function medianRegions(list: readonly (Group['regions'] | undefined)[]): Record<string, { ms: number; renders: number }> {
  const present = list.filter((regions): regions is NonNullable<Group['regions']> => regions !== undefined);
  const names = [...new Set(present.flatMap((regions) => Object.keys(regions)))];
  return Object.fromEntries(
    names.map((name) => [name, { ms: median(present.map((regions) => regions[name]?.ms ?? 0)), renders: median(present.map((regions) => regions[name]?.renders ?? 0)) }]),
  );
}

function medianGroup(groups: readonly (Group | undefined)[]): Group {
  const present = groups.filter((group): group is Group => group !== undefined);
  const out: Group = { n: median(present.map((group) => group.n)) };
  const measureMs = medianStats(present.map((group) => group.measureMs));
  if (measureMs) out.measureMs = measureMs;
  const engineMs = medianStats(present.map((group) => group.engineMs));
  if (engineMs) out.engineMs = engineMs;
  for (const key of ['totals', 'milestones', 'segments', 'work', 'commits', 'after', 'drag'] as const) {
    const map = medianMap(present.map((group) => group[key]));
    if (map) out[key] = map;
  }
  if (present.some((group) => group.components)) out.components = medianComponents(present.map((group) => group.components));
  if (present.some((group) => group.dragComponents)) out.dragComponents = medianComponents(present.map((group) => group.dragComponents));
  if (present.some((group) => group.regions)) out.regions = medianRegions(present.map((group) => group.regions));
  return out;
}

function medianRecord(list: readonly Record<string, number>[]): Record<string, number> {
  const keys = [...new Set(list.flatMap((record) => Object.keys(record)))];
  const entries: [string, number][] = keys.map((key) => [key, median(list.map((record) => record[key] ?? 0))]);
  return Object.fromEntries(entries.sort((a, b) => b[1] - a[1]));
}

/** Brush views from the samples: per sample, the slowest chart, the count and the grid page. */
function brushViews(runs: readonly Run[]) {
  const perRun = runs.map((run) => {
    const samples = run.samples.brush.flatMap((sample) => (sample.analysis ? [sample.analysis.views] : []));
    const pick = (views: ViewTiming[], kind: 'chart' | 'status' | 'grid') => views.filter((view) => (kind === 'chart' ? view.view.startsWith('chart:') : view.view === kind));
    const p50 = (values: number[]) => median(values);
    return {
      chartEngineMaxMs: p50(samples.map((views) => Math.max(...pick(views, 'chart').map((view) => view.engineMs)))),
      chartLastReplyMs: p50(samples.map((views) => Math.max(...pick(views, 'chart').map((view) => view.reply ?? Number.NaN)))),
      chartLastDrawnMs: p50(samples.map((views) => Math.max(...pick(views, 'chart').map((view) => view.drawn ?? Number.NaN)))),
      countEngineMs: p50(samples.map((views) => Math.max(...pick(views, 'status').map((view) => view.engineMs)))),
      countReplyMs: p50(samples.map((views) => Math.max(...pick(views, 'status').map((view) => view.reply ?? Number.NaN)))),
      gridEngineMs: p50(samples.map((views) => Math.max(...pick(views, 'grid').map((view) => view.engineMs)))),
      gridReplyMs: p50(samples.map((views) => Math.max(...pick(views, 'grid').map((view) => view.reply ?? Number.NaN)))),
      decodeMsSum: p50(samples.map((views) => views.reduce((sum, view) => sum + view.decodeMs, 0))),
      requests: p50(samples.map((views) => views.length)),
    };
  });
  return medianRecord(perRun);
}

function summarize(runs: readonly Run[]) {
  const createKeys = [...new Set(runs.flatMap((run) => Object.keys(run.summary.create)))];
  const profiles = [...new Set(runs.flatMap((run) => Object.keys(run.summary.profiles)))];
  const traces = [...new Set(runs.flatMap((run) => Object.keys(run.summary.traces)))];
  return {
    runs: runs.length,
    recordedAt: runs.map((run) => run.recordedAt),
    create: Object.fromEntries(
      createKeys.map((key) => [
        key,
        {
          ...medianGroup(runs.map((run) => run.summary.create[key])),
          segments: medianMap(runs.map((run) => segmentStats(run.samples.create[key] ?? [], createChain))),
        },
      ]),
    ),
    brush: {
      ...medianGroup(runs.map((run) => run.summary.brush)),
      segments: medianMap(runs.map((run) => segmentStats(run.samples.brush, () => INTERACTION_CHAIN))),
      views: brushViews(runs),
    },
    brushStart: medianGroup(runs.map((run) => run.summary.brushStart)),
    select: { ...medianGroup(runs.map((run) => run.summary.select)), segments: medianMap(runs.map((run) => segmentStats(run.samples.select, () => INTERACTION_CHAIN))) },
    profiles: Object.fromEntries(
      profiles.map((name) => {
        const list = runs.flatMap((run) => (run.summary.profiles[name] ? [run.summary.profiles[name]] : []));
        const functions = new Map<string, number[]>();
        for (const profile of list) for (const spot of profile.top) functions.set(`${spot.function} — ${spot.module}`, [...(functions.get(`${spot.function} — ${spot.module}`) ?? []), spot.selfMs]);
        return [
          name,
          {
            totalMs: median(list.map((profile) => profile.totalMs)),
            byCategory: medianRecord(list.map((profile) => profile.byCategory)),
            top: [...functions]
              .map(([fn, values]) => ({ function: fn, selfMs: median([...values, ...Array<number>(list.length - values.length).fill(0)]) }))
              .sort((a, b) => b.selfMs - a.selfMs)
              .slice(0, 25),
          },
        ];
      }),
    ),
    traces: Object.fromEntries(
      traces.map((name) => {
        const list = runs.flatMap((run) => (run.summary.traces[name] ? [run.summary.traces[name]] : []));
        return [
          name,
          {
            busyMs: median(list.map((trace) => trace.busyMs)),
            forced: medianRecord(list.flatMap((trace) => (trace.forced ? [trace.forced] : []))),
            byCategory: medianRecord(list.map((trace) => trace.byCategory)),
            byEvent: Object.entries(medianRecord(list.map((trace) => Object.fromEntries(trace.byEvent.map((event) => [event.name, event.selfMs])))))
              .slice(0, 15)
              .map(([event, selfMs]) => ({ name: event, selfMs })),
          },
        ];
      }),
    ),
  };
}

// ---------------------------------------------------------------------------

const [outFile, ...inputs] = process.argv.slice(2);
if (!outFile || inputs.length === 0) {
  console.error('usage: node render-perf-medians.ts <out.json> <run.json>…');
  process.exit(2);
}
const runs = inputs.map((file) => JSON.parse(readFileSync(file, 'utf8')) as Run);
const groups = new Map<string, Run[]>();
for (const run of runs) {
  const key = `${run.rows}:${run.instrumented ? 'instrumented' : 'plain'}`;
  groups.set(key, [...(groups.get(key) ?? []), run]);
}
const out = Object.fromEntries([...groups].map(([key, list]) => [key, summarize(list)]));
// Numbers to 0.01 ms (timer resolution is coarser).
const round = (_key: string, value: unknown) => (typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * 100) / 100 : value);
writeFileSync(outFile, `${JSON.stringify({ benchmark: 'render-perf-medians', inputs: inputs.map((file) => file.replace(/^.*\//, '')), ...out }, round, 2)}\n`);

// Markdown for the doc.
const f = (value: number | undefined) => (value === undefined || !Number.isFinite(value) ? '–' : value.toFixed(1));
for (const [key, summary] of Object.entries(out)) {
  console.info(`\n## ${key} (${summary.runs} runs)\n`);
  for (const [name, group] of Object.entries(summary.create)) {
    const t = group.totals ?? {};
    console.info(
      `create ${name}: measure p50 ${f(group.measureMs?.p50)} p95 ${f(group.measureMs?.p95)} | engine p50 ${f(group.engineMs?.p50)} | toDrawn ${f(t['toDrawn']?.p50)}/${f(t['toDrawn']?.p95)} | toPresented ${f(t['toPresented']?.p50)}/${f(t['toPresented']?.p95)} | nonEngine ${f(t['nonEngine']?.p50)}/${f(t['nonEngine']?.p95)}`,
    );
  }
  for (const [name, group] of Object.entries(summary.create)) {
    if (!group.segments) continue;
    console.info(`\n### create ${name}: segments (p50 / p95 / max)\n`);
    const order = Object.entries(group.milestones ?? {}).sort((a, b) => a[1].p50 - b[1].p50);
    console.info(order.map(([milestone, s]) => `${milestone} @${f(s.p50)}`).join(' → '));
    for (const [segment, s] of Object.entries(group.segments)) {
      console.info(`| ${segment} | ${f(s.p50)} | ${f(s.p95)} | ${f(s.max)} |`);
    }
    for (const [work, s] of Object.entries(group.work ?? {})) console.info(`| work ${work} | ${f(s.p50)} | ${f(s.p95)} | ${f(s.max)} |`);
    for (const [commit, s] of Object.entries(group.commits ?? {})) console.info(`| commits ${commit} | ${f(s.p50)} | ${f(s.p95)} | ${f(s.max)} |`);
  }
}
console.info(`\nwrote ${outFile}`);

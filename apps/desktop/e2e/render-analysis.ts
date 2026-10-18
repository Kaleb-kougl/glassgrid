import type { RenderCause, RenderPerfCommit, RenderPerfEvent, RenderPerfRecording } from '../src/renderer/src/perf';
import { stats } from './support';

/*
 * Turns render-perf recordings (src/renderer/src/render-perf-core.ts) into
 * the benchmark's numbers: per-interaction milestones (ms after the input
 * event), the segments between them, the work measured inside them, and the
 * React commits with the components that rendered (needed or wasted).
 */

export type Stats = ReturnType<typeof stats>;

export interface ComponentTally {
  renders: number;
  wasted: number;
  selfMs: number;
  causes: Partial<Record<RenderCause, number>>;
  /** Props that changed identity on wasted renders, with how often. */
  unstableProps: Record<string, number>;
}

export interface CommitSummary {
  count: number;
  /** Render phase, whole tree (root Profiler actualDuration), summed. */
  renderMs: number;
  /** Commit phase start -> end of layout phase, summed (DOM mutations, layout effects incl. canvas draws). */
  commitMs: number;
  layoutEffectsMs: number;
  /** The commit inspector's own time (instrumentation overhead). */
  inspectMs: number;
  renders: number;
  wasted: number;
  /** Profiler regions: render ms summed. */
  regions: Record<string, number>;
  /** Renders per Profiler region. */
  regionRenders: Record<string, number>;
  components: Record<string, ComponentTally>;
}

export function summarizeCommits(commits: readonly RenderPerfCommit[], from: number, to: number): CommitSummary {
  const summary: CommitSummary = {
    count: 0,
    renderMs: 0,
    commitMs: 0,
    layoutEffectsMs: 0,
    inspectMs: 0,
    renders: 0,
    wasted: 0,
    regions: {},
    regionRenders: {},
    components: {},
  };
  for (const commit of commits) {
    if (commit.end < from || commit.end > to) continue;
    summary.count += 1;
    summary.renderMs += commit.renderMs;
    summary.commitMs += commit.end - commit.start;
    summary.layoutEffectsMs += commit.layoutEffectsMs ?? 0;
    summary.inspectMs += commit.inspectMs;
    for (const [region, ms] of Object.entries(commit.regions)) summary.regions[region] = (summary.regions[region] ?? 0) + ms;
    for (const render of commit.components) {
      summary.renders += 1;
      if (render.wasted) summary.wasted += 1;
      summary.regionRenders[render.region] = (summary.regionRenders[render.region] ?? 0) + 1;
      const tally = (summary.components[render.name] ??= { renders: 0, wasted: 0, selfMs: 0, causes: {}, unstableProps: {} });
      tally.renders += 1;
      tally.selfMs += render.selfMs;
      tally.causes[render.cause] = (tally.causes[render.cause] ?? 0) + 1;
      if (render.wasted) {
        tally.wasted += 1;
        for (const prop of render.changed ?? []) tally.unstableProps[prop] = (tally.unstableProps[prop] ?? 0) + 1;
      }
    }
  }
  return summary;
}

export interface CommitLine {
  /** Commit start, ms after the input event. */
  at: number;
  renderMs: number;
  commitMs: number;
  renders: number;
  wasted: number;
  /** Rendered components by own render time, most expensive first (at most 8), `name×count`. */
  top: string[];
}

/** One line per commit in [from, to]: when, how long, what rendered. */
export function commitTimeline(commits: readonly RenderPerfCommit[], origin: number, from: number, to: number): CommitLine[] {
  return commits
    .filter((commit) => commit.end >= from && commit.end <= to)
    .map((commit) => {
      const byName = new Map<string, { count: number; ms: number }>();
      for (const render of commit.components) {
        const entry = byName.get(render.name) ?? { count: 0, ms: 0 };
        entry.count += 1;
        entry.ms += render.selfMs;
        byName.set(render.name, entry);
      }
      return {
        at: commit.start - origin,
        renderMs: commit.renderMs,
        commitMs: commit.end - commit.start,
        renders: commit.components.length,
        wasted: commit.components.filter((render) => render.wasted).length,
        top: [...byName]
          .sort((a, b) => b[1].ms - a[1].ms)
          .slice(0, 8)
          .map(([name, entry]) => `${name}×${entry.count}`),
      };
    });
}

const first = (events: readonly RenderPerfEvent[], test: (event: RenderPerfEvent) => boolean, after = -Infinity) =>
  events.find((event) => event.t >= after && test(event));
const last = (events: readonly RenderPerfEvent[], test: (event: RenderPerfEvent) => boolean) => events.filter(test).at(-1);
const sumMs = (events: readonly RenderPerfEvent[], test: (event: RenderPerfEvent) => boolean) =>
  events.filter(test).reduce((sum, event) => sum + (event.ms ?? 0), 0);

/**
 * The order of a create's milestones (the draw sits inside the commit that
 * drew it, or after the data commit when a chart draws in a passive effect).
 * Shared with render-perf-medians.ts, which re-derives segments from saved milestones.
 */
export function createChain(milestones: Record<string, number>): string[] {
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

/** A brush or key press: the chain from the input to the frame after the last draw (`last-reply` is reported, not chained). */
export const INTERACTION_CHAIN = ['input', 'dispatch', 'notify', 'render', 'first-commit-start', 'first-commit-end', 'first-request', 'last-drawn', 'raf', 'presented'];

/** `a→b` durations between consecutive milestones of `chain` that are present. */
export function segmentsOf(milestones: Record<string, number>, chain: readonly string[]): Record<string, number> {
  const present = chain.filter((name) => milestones[name] !== undefined);
  const segments: Record<string, number> = {};
  for (let i = 1; i < present.length; i += 1) {
    const a = present[i - 1] ?? '';
    const b = present[i] ?? '';
    segments[`${a}→${b}`] = (milestones[b] ?? 0) - (milestones[a] ?? 0);
  }
  return segments;
}

function relative(milestones: Record<string, number | undefined>, origin: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, t] of Object.entries(milestones)) if (t !== undefined) out[name] = t - origin;
  return out;
}

/** The first animation frame after `after` and the task after it rendered (the frame that shows what was committed or drawn by then). */
function presentedAfter(events: readonly RenderPerfEvent[], after: number) {
  const raf = first(events, (event) => event.type === 'raf', after)?.t;
  return { raf, presented: raf === undefined ? undefined : first(events, (event) => event.type === 'presented', raf)?.t };
}

export interface CreateAnalysis {
  chartId: string;
  engineMs: number;
  cached: boolean;
  bytes: number;
  /** ms after the drop event. */
  milestones: Record<string, number>;
  segments: Record<string, number>;
  work: {
    shellRenderMs: number;
    shellCommitMs: number;
    validateMs: number;
    decodeMs: number;
    adaptMs: number;
    modelMs: number;
    dataRenderMs: number;
    dataCommitMs: number;
    /** The follow-up commit that drew (0 when the data commit drew, or the chart draws in a passive effect). */
    drawRenderMs: number;
    drawCommitMs: number;
    layersMs: number;
    paintMs: number;
  };
  totals: {
    /** Drop event -> onDrawn. */
    toDrawn: number;
    /** Drop event -> the frame after the draw rendered. */
    toPresented: number;
    /** toPresented minus the engine's own time. */
    nonEngine: number;
    /** Request posted -> reply received, minus engine time (IPC, the engine host's queueing and encode, result cache). */
    ipcAndHost: number;
  };
  commits: CommitSummary;
  /** Commits after the frame (deferred screen-reader table, layout follow-ups) until the recording was taken. */
  after: CommitSummary;
  /** Commits while the column was dragged, before the drop (drag start, drag over the panel). */
  drag: CommitSummary;
  /** Every commit from the drop to the end of the recording. */
  timeline: CommitLine[];
}

/** One chart create (drop -> new chart drawn -> next frame). */
export function analyzeCreate(recording: RenderPerfRecording, chartId: string): CreateAnalysis {
  const { events, commits } = recording;
  const view = `chart:${chartId}`;
  const input = first(events, (event) => event.type === 'input')?.t ?? first(events, (event) => event.type === 'dispatch')?.t;
  if (input === undefined) throw new Error('create recording has no input or dispatch event');
  const request = first(events, (event) => event.type === 'request' && event.view === view);
  const byRequest = (type: string) => first(events, (event) => event.type === type && event.requestId === request?.requestId);
  const reply = byRequest('reply');
  const validated = byRequest('validated');
  const decoded = byRequest('decoded');
  const render = first(events, (event) => event.type === 'render');
  const dataRender = first(events, (event) => event.type === 'data-render' && event.chartId === chartId);
  const drawn = first(events, (event) => event.type === 'drawn' && event.chartId === chartId);
  if (!request || !reply || !dataRender || !drawn || !render) throw new Error(`incomplete create recording for ${chartId}`);
  const shell = commits.find((commit) => commit.end >= render.t);
  const data = commits.find((commit) => commit.start >= dataRender.t);
  // Charts that draw in a layout effect draw inside a commit: the data commit, or a follow-up one (a size measured on mount).
  const draw = commits.find((commit) => commit.start <= drawn.t && drawn.t <= commit.end);
  const settled = Math.max(drawn.t, data?.end ?? drawn.t, draw?.end ?? drawn.t);
  const frame = presentedAfter(events, settled);
  const milestones = relative(
    {
      input,
      dispatch: first(events, (event) => event.type === 'dispatch')?.t,
      notify: first(events, (event) => event.type === 'notify')?.t,
      render: render.t,
      'shell-commit-start': shell?.start,
      'shell-commit-end': shell?.end,
      query: first(events, (event) => event.type === 'query' && event.view === view)?.t,
      request: request.t,
      reply: reply.t,
      validated: validated?.t,
      decoded: decoded?.t,
      resolved: first(events, (event) => event.type === 'resolved' && event.view === view)?.t,
      'data-render': dataRender.t,
      'data-commit-start': data?.start,
      'data-commit-end': data?.end,
      ...(draw && draw !== data ? { 'draw-commit-start': draw.start, 'draw-commit-end': draw.end } : {}),
      drawn: drawn.t,
      raf: frame.raf,
      presented: frame.presented,
    },
    input,
  );
  const between = (event: RenderPerfEvent, from: number, to: number) => event.t >= from && event.t <= to;
  const engineMs = reply.engineMs ?? 0;
  const presented = frame.presented ?? settled;
  return {
    chartId,
    engineMs,
    cached: reply.cached === true,
    bytes: reply.bytes ?? 0,
    milestones,
    segments: segmentsOf(milestones, createChain(milestones)),
    work: {
      shellRenderMs: shell?.renderMs ?? 0,
      shellCommitMs: shell ? shell.end - shell.start : 0,
      validateMs: validated ? validated.t - reply.t : 0,
      decodeMs: decoded?.ms ?? 0,
      adaptMs: sumMs(events, (event) => event.type === 'adapt' && event.chartId === chartId),
      modelMs: sumMs(events, (event) => event.type === 'model' && between(event, dataRender.t, drawn.t)),
      dataRenderMs: data?.renderMs ?? 0,
      dataCommitMs: data ? data.end - data.start : 0,
      drawRenderMs: draw && draw !== data ? draw.renderMs : 0,
      drawCommitMs: draw && draw !== data ? draw.end - draw.start : 0,
      layersMs: sumMs(events, (event) => event.type === 'layers' && between(event, dataRender.t, drawn.t)),
      paintMs: sumMs(events, (event) => event.type === 'paint' && between(event, dataRender.t, drawn.t)),
    },
    totals: {
      toDrawn: drawn.t - input,
      toPresented: presented - input,
      nonEngine: presented - input - engineMs,
      ipcAndHost: reply.t - request.t - engineMs,
    },
    commits: summarizeCommits(commits, input, presented),
    after: summarizeCommits(commits, presented + 1e-6, Infinity),
    drag: summarizeCommits(commits, -Infinity, input - 1e-6),
    timeline: commitTimeline(commits, input, input, Infinity),
  };
}

export interface ViewTiming {
  view: string;
  engineMs: number;
  cached: boolean;
  /** ms after the input event. */
  request: number;
  reply: number | null;
  drawn: number | null;
  decodeMs: number;
}

export interface InteractionAnalysis {
  milestones: Record<string, number>;
  segments: Record<string, number>;
  work: { validateMs: number; decodeMs: number; adaptMs: number; modelMs: number; layersMs: number; paintMs: number; firstRenderMs: number; firstCommitMs: number };
  views: ViewTiming[];
  totals: { toFirstCommit: number; toPresented: number };
  commits: CommitSummary;
  after: CommitSummary;
  /** Every commit from the input to the end of the recording. */
  timeline: CommitLine[];
}

/**
 * A brush release or a grid key press: input -> first commit -> (requests,
 * replies, every redraw) -> the frame after the last draw (or after the first
 * commit when nothing is drawn).
 */
export function analyzeInteraction(recording: RenderPerfRecording): InteractionAnalysis {
  const { events, commits } = recording;
  const input = first(events, (event) => event.type === 'input')?.t ?? first(events, (event) => event.type === 'dispatch')?.t;
  if (input === undefined) throw new Error(`${recording.kind} recording has no input or dispatch event`);
  const firstCommit = commits.find((commit) => commit.end >= input);
  const lastDrawn = last(events, (event) => event.type === 'drawn');
  const settled = Math.max(lastDrawn?.t ?? -Infinity, firstCommit?.end ?? input);
  const frame = presentedAfter(events, settled);
  const requests = events.filter((event) => event.type === 'request');
  const views: ViewTiming[] = requests.map((request) => {
    const reply = first(events, (event) => event.type === 'reply' && event.requestId === request.requestId);
    const decoded = first(events, (event) => event.type === 'decoded' && event.requestId === request.requestId);
    const chartId = request.view?.startsWith('chart:') ? request.view.slice('chart:'.length) : undefined;
    const drawn = chartId === undefined ? undefined : first(events, (event) => event.type === 'drawn' && event.chartId === chartId, reply?.t ?? request.t);
    return {
      view: request.view ?? request.requestKind ?? '?',
      engineMs: reply?.engineMs ?? 0,
      cached: reply?.cached === true,
      request: request.t - input,
      reply: reply ? reply.t - input : null,
      drawn: drawn ? drawn.t - input : null,
      decodeMs: decoded?.ms ?? 0,
    };
  });
  const replies = events.filter((event) => event.type === 'reply');
  const milestones = relative(
    {
      input,
      dispatch: first(events, (event) => event.type === 'dispatch')?.t,
      notify: first(events, (event) => event.type === 'notify')?.t,
      render: first(events, (event) => event.type === 'render')?.t,
      'first-commit-start': firstCommit?.start,
      'first-commit-end': firstCommit?.end,
      'first-request': requests[0]?.t,
      'last-reply': replies.at(-1)?.t,
      'last-drawn': lastDrawn?.t,
      raf: frame.raf,
      presented: frame.presented,
    },
    input,
  );
  const validateMs = replies.reduce((sum, reply) => {
    const validated = first(events, (event) => event.type === 'validated' && event.requestId === reply.requestId);
    return sum + (validated ? validated.t - reply.t : 0);
  }, 0);
  const presented = frame.presented ?? settled;
  return {
    milestones,
    segments: segmentsOf(milestones, INTERACTION_CHAIN),
    work: {
      validateMs,
      decodeMs: sumMs(events, (event) => event.type === 'decoded'),
      adaptMs: sumMs(events, (event) => event.type === 'adapt'),
      modelMs: sumMs(events, (event) => event.type === 'model'),
      layersMs: sumMs(events, (event) => event.type === 'layers'),
      paintMs: sumMs(events, (event) => event.type === 'paint'),
      firstRenderMs: firstCommit?.renderMs ?? 0,
      firstCommitMs: firstCommit ? firstCommit.end - firstCommit.start : 0,
    },
    views,
    totals: { toFirstCommit: (firstCommit?.end ?? input) - input, toPresented: presented - input },
    commits: summarizeCommits(commits, input, presented),
    after: summarizeCommits(commits, presented + 1e-6, Infinity),
    timeline: commitTimeline(commits, input, input, Infinity),
  };
}

// ---------------------------------------------------------------------------
// Aggregation over samples

/** Stats of every numeric field reached by `pick` (nested objects flattened with dots) over the samples that have it. */
export function statsByField<T>(samples: readonly T[], pick: (sample: T) => Record<string, unknown>): Record<string, Stats> {
  const values = new Map<string, number[]>();
  const walk = (prefix: string, value: unknown) => {
    if (typeof value === 'number') {
      const list = values.get(prefix) ?? [];
      list.push(value);
      values.set(prefix, list);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      for (const [key, inner] of Object.entries(value)) walk(prefix === '' ? key : `${prefix}.${key}`, inner);
    }
  };
  for (const sample of samples) walk('', pick(sample));
  return Object.fromEntries([...values].map(([key, list]) => [key, stats(list)]));
}

export interface ComponentRow {
  name: string;
  /** Mean per sample. */
  renders: number;
  wasted: number;
  selfMs: number;
  causes: Partial<Record<RenderCause, number>>;
  unstableProps: string[];
}

/** Component renders per sample (mean), most rendered first. */
export function componentTable(summaries: readonly CommitSummary[]): ComponentRow[] {
  const n = Math.max(1, summaries.length);
  const merged = new Map<string, ComponentTally>();
  for (const summary of summaries) {
    for (const [name, tally] of Object.entries(summary.components)) {
      const into = merged.get(name) ?? { renders: 0, wasted: 0, selfMs: 0, causes: {}, unstableProps: {} };
      into.renders += tally.renders;
      into.wasted += tally.wasted;
      into.selfMs += tally.selfMs;
      for (const [cause, count] of Object.entries(tally.causes) as [RenderCause, number][]) into.causes[cause] = (into.causes[cause] ?? 0) + count;
      for (const [prop, count] of Object.entries(tally.unstableProps)) into.unstableProps[prop] = (into.unstableProps[prop] ?? 0) + count;
      merged.set(name, into);
    }
  }
  return [...merged]
    .map(([name, tally]) => ({
      name,
      renders: tally.renders / n,
      wasted: tally.wasted / n,
      selfMs: tally.selfMs / n,
      causes: Object.fromEntries(Object.entries(tally.causes).map(([cause, count]) => [cause, count / n])),
      unstableProps: Object.entries(tally.unstableProps)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([prop]) => prop),
    }))
    .sort((a, b) => b.renders - a.renders || b.selfMs - a.selfMs);
}

/** Mean per sample of the regions' render time and render counts. */
export function regionTable(summaries: readonly CommitSummary[]): Record<string, { ms: number; renders: number }> {
  const n = Math.max(1, summaries.length);
  const out: Record<string, { ms: number; renders: number }> = {};
  for (const summary of summaries) {
    for (const [region, ms] of Object.entries(summary.regions)) (out[region] ??= { ms: 0, renders: 0 }).ms += ms / n;
    for (const [region, renders] of Object.entries(summary.regionRenders)) (out[region] ??= { ms: 0, renders: 0 }).renders += renders / n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// CPU profiles (CDP Profiler.stop)

export interface CpuProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children?: number[];
}

export interface CpuProfile {
  nodes: CpuProfileNode[];
  startTime: number;
  endTime: number;
  samples: number[];
  timeDeltas: number[];
}

/** Bundle line -> source module, from the `//#region <path>` markers rolldown writes in unminified output. */
export function bundleRegions(source: string): (line: number) => string {
  const starts: { line: number; module: string }[] = [];
  source.split('\n').forEach((text, index) => {
    const match = /^\/\/#region (.+)$/.exec(text);
    if (match?.[1]) starts.push({ line: index, module: match[1].replace(/^.*node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?/, 'npm:') });
  });
  return (line) => {
    let lo = 0;
    let hi = starts.length - 1;
    let found = '(bundle)';
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const start = starts[mid];
      if (!start) break;
      if (start.line <= line) {
        found = start.module;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
}

export interface HotSpot {
  function: string;
  module: string;
  /** Self time per interaction (mean over the windows). */
  selfMs: number;
  share: number;
}

export interface ProfileSummary {
  windows: number;
  /** Sampled time inside the windows, per interaction. */
  totalMs: number;
  byCategory: Record<string, number>;
  byModule: { module: string; selfMs: number }[];
  top: HotSpot[];
}

function categoryOf(module: string, functionName: string): string {
  if (functionName === '(garbage collector)') return 'GC';
  if (functionName === '(idle)') return 'idle';
  if (functionName === '(program)') return 'browser (style, layout, paint, raster, IPC)';
  if (module.includes('react-dom') || module.includes('npm:react') || module.includes('npm:scheduler')) return 'React';
  if (module.includes('apache-arrow')) return 'Arrow';
  if (module.includes('npm:zod')) return 'zod';
  if (module.includes('npm:immer')) return 'immer';
  if (module.includes('npm:d3')) return 'd3';
  if (module.includes('packages/ui/src/charts') || module.includes('packages/ui/src/components/BarChart')) return 'charts (ui)';
  if (module.includes('packages/ui/src/grid')) return 'grid (ui)';
  if (module.includes('packages/ui')) return 'ui components';
  if (module.includes('packages/core')) return 'core (state, commands, queries)';
  if (module.includes('render-perf')) return 'instrumentation';
  if (module.includes('src/renderer')) return 'app (renderer)';
  if (module === '(native)' || module === '') return 'native/builtins';
  return 'other';
}

/**
 * Self time per function inside `windows` ([start, end] in the profile's own
 * microsecond clock), averaged per window.
 */
export function summarizeProfile(profile: CpuProfile, windows: readonly (readonly [number, number])[], moduleOf: (url: string, line: number) => string): ProfileSummary {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map<number, number>();
  let t = profile.startTime;
  for (let i = 0; i < profile.samples.length; i += 1) {
    t += profile.timeDeltas[i] ?? 0;
    const duration = profile.timeDeltas[i + 1] ?? 0;
    if (!windows.some(([from, to]) => t >= from && t < to)) continue;
    const id = profile.samples[i] ?? -1;
    self.set(id, (self.get(id) ?? 0) + duration);
  }
  const n = Math.max(1, windows.length);
  const byKey = new Map<string, HotSpot>();
  const byCategory: Record<string, number> = {};
  const byModule = new Map<string, number>();
  let total = 0;
  for (const [id, us] of self) {
    const node = nodes.get(id);
    if (!node) continue;
    const { functionName, url, lineNumber } = node.callFrame;
    const module = url === '' ? '(native)' : moduleOf(url, lineNumber);
    const name = functionName === '' ? '(anonymous)' : functionName;
    const ms = us / 1000 / n;
    total += ms;
    const key = `${name}|${module}`;
    const spot = byKey.get(key) ?? { function: name, module, selfMs: 0, share: 0 };
    spot.selfMs += ms;
    byKey.set(key, spot);
    const category = categoryOf(module, name);
    byCategory[category] = (byCategory[category] ?? 0) + ms;
    byModule.set(module, (byModule.get(module) ?? 0) + ms);
  }
  const top = [...byKey.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 30);
  for (const spot of top) spot.share = total > 0 ? spot.selfMs / total : 0;
  return {
    windows: windows.length,
    totalMs: total,
    byCategory: Object.fromEntries(Object.entries(byCategory).sort((a, b) => b[1] - a[1])),
    byModule: [...byModule].map(([module, selfMs]) => ({ module, selfMs })).sort((a, b) => b.selfMs - a.selfMs).slice(0, 25),
    top,
  };
}

/** Time of the first sample inside a function called `name`, or in anything it calls (profile clock, µs). */
export function firstSampleIn(profile: CpuProfile, name: string): number | null {
  const ids = new Set<number>();
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const mark = (id: number) => {
    ids.add(id);
    for (const child of byId.get(id)?.children ?? []) mark(child);
  };
  for (const node of profile.nodes) if (node.callFrame.functionName === name) mark(node.id);
  let t = profile.startTime;
  for (let i = 0; i < profile.samples.length; i += 1) {
    t += profile.timeDeltas[i] ?? 0;
    if (ids.has(profile.samples[i] ?? -1)) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chrome traces (Electron contentTracing): what the renderer's main thread did, by trace event

export interface TraceEvent {
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  ph: string;
  name: string;
  cat?: string;
  args?: { name?: string } & Record<string, unknown>;
}

export interface TraceSummary {
  windows: number;
  /** Main-thread time inside the windows, per interaction, by trace event (self time). */
  byEvent: { name: string; selfMs: number }[];
  byCategory: Record<string, number>;
  /** Main-thread busy time per interaction (top-level tasks clipped to the windows). */
  busyMs: number;
  /**
   * Style and layout forced by script (an UpdateLayoutTree / Layout inside a
   * FunctionCall, timer, rAF callback, microtask or event: a read of layout
   * after a write), per interaction; the rest ran in the frame.
   */
  forced: { styleMs: number; layoutMs: number; count: number };
}

const TRACE_CATEGORIES: [RegExp, string][] = [
  [/^(MinorGC|MajorGC|V8\.GC|BlinkGC|GCEvent|ScavengerTask|CppGC)/, 'GC'],
  [/^(UpdateLayoutTree|RecalculateStyles|ScheduleStyleRecalculation|ParseAuthorStyleSheet)/, 'style'],
  [/^(Layout|UpdateLayout|LayoutShift|IntersectionObserverController)/, 'layout'],
  [/^(PrePaint|Paint|PaintImage|Layerize|Commit|UpdateLayer|UpdateLayerTree|CompositeLayers|Decode|ImageDecodeTask|RasterTask|Canvas)/, 'paint & composite'],
  [/^(HitTest|EventDispatch|EventTiming)/, 'input & events'],
  [/^(FunctionCall|EvaluateScript|v8\.|V8\.|TimerFire|FireAnimationFrame|RunMicrotasks|FireIdleCallback|XHR|ScheduleStyleInvalidation|v8)/, 'script'],
  [/^(RunTask|ThreadControllerImpl::RunTask|TaskQueueManager|SequenceManager)/, 'task overhead'],
];

/** Trace events that run script: style or layout inside one was forced by a read. */
const SCRIPT_EVENT = /^(FunctionCall|EvaluateScript|v8\.callFunction|V8\.Execute|EventDispatch|TimerFire|FireAnimationFrame|RunMicrotasks|FireIdleCallback)/;

function traceCategory(name: string): string {
  for (const [pattern, category] of TRACE_CATEGORIES) if (pattern.test(name)) return category;
  return 'other';
}

/** The renderer main thread (`CrRendererMain`) of the process that recorded `marker` as a user-timing mark. */
export function rendererMainThread(events: readonly TraceEvent[], marker: string): { pid: number; tid: number; markerTs: number } | null {
  const mark = events.find((event) => event.name === marker);
  if (!mark) return null;
  const main = events.find((event) => event.ph === 'M' && event.name === 'thread_name' && event.pid === mark.pid && event.args?.name === 'CrRendererMain');
  return main ? { pid: main.pid, tid: main.tid, markerTs: mark.ts } : null;
}

/** Self time per trace event on one thread inside `windows` (trace clock, µs), averaged per window. */
export function summarizeTrace(events: readonly TraceEvent[], thread: { pid: number; tid: number }, windows: readonly (readonly [number, number])[]): TraceSummary {
  const spans = events
    .filter((event) => event.pid === thread.pid && event.tid === thread.tid && event.ph === 'X' && typeof event.dur === 'number')
    .sort((a, b) => a.ts - b.ts || (b.dur ?? 0) - (a.dur ?? 0));
  const self = new Map<string, number>();
  let busy = 0;
  const inWindow = (ts: number) => windows.some(([from, to]) => ts >= from && ts < to);
  const clipped = (from: number, to: number) => windows.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(to, b) - Math.max(from, a)), 0);
  // Nesting: a stack of open spans; each span's self time is its duration minus its direct children's.
  const stack: { event: TraceEvent; end: number; children: number; forced: boolean }[] = [];
  const forced = { styleUs: 0, layoutUs: 0, count: 0 };
  const close = (item: { event: TraceEvent; end: number; children: number; forced: boolean }) => {
    const selfUs = (item.event.dur ?? 0) - item.children;
    if (!inWindow(item.event.ts)) return;
    self.set(item.event.name, (self.get(item.event.name) ?? 0) + selfUs);
    if (item.forced && item.event.name === 'Layout') forced.layoutUs += selfUs;
    if (item.forced && item.event.name === 'UpdateLayoutTree') forced.styleUs += selfUs;
  };
  for (const event of spans) {
    const end = event.ts + (event.dur ?? 0);
    while (stack.length > 0 && (stack.at(-1)?.end ?? 0) <= event.ts) {
      const done = stack.pop();
      if (done) close(done);
    }
    const parent = stack.at(-1);
    if (parent) parent.children += event.dur ?? 0;
    else busy += clipped(event.ts, end);
    const isForced = (event.name === 'Layout' || event.name === 'UpdateLayoutTree') && stack.some((item) => SCRIPT_EVENT.test(item.event.name));
    if (isForced && event.name === 'Layout' && inWindow(event.ts)) forced.count += 1;
    stack.push({ event, end, children: 0, forced: isForced });
  }
  while (stack.length > 0) {
    const done = stack.pop();
    if (done) close(done);
  }
  const n = Math.max(1, windows.length);
  const byCategory: Record<string, number> = {};
  const byEvent = [...self].map(([name, us]) => ({ name, selfMs: us / 1000 / n })).sort((a, b) => b.selfMs - a.selfMs);
  for (const { name, selfMs } of byEvent) byCategory[traceCategory(name)] = (byCategory[traceCategory(name)] ?? 0) + selfMs;
  return {
    windows: windows.length,
    byEvent: byEvent.slice(0, 30),
    byCategory: Object.fromEntries(Object.entries(byCategory).sort((a, b) => b[1] - a[1])),
    busyMs: busy / 1000 / n,
    forced: { styleMs: forced.styleUs / 1000 / n, layoutMs: forced.layoutUs / 1000 / n, count: forced.count / n },
  };
}

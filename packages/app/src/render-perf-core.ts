import type { WorkspaceStore } from '@glassgrid/core';
import {
  RENDER_PERF_MARK_PREFIX,
  type RenderCause,
  type RenderPerfCommit,
  type RenderPerfComponentRender,
  type RenderPerfEvent,
  type RenderPerfRecording,
} from './perf';

/*
 * Render-path instrumentation for the E2E render benchmark
 * (e2e/render-perf.spec.ts), compiled in only by `GLASSGRID_RENDER_PERF=1`
 * builds: every call site is behind `if (__GG_RENDER_PERF__)`, which is
 * `false` in ordinary builds, so the calls and this module drop out.
 *
 * This module has no runtime imports: main.tsx imports it first, so its
 * React DevTools hook (the commit inspector) is in place before react-dom
 * loads, and the engine client can report to it without pulling in React.
 * React-side pieces (Profiler regions, the chart draw hook) are in
 * render-perf.ts.
 *
 * The benchmark arms one interaction (`create`, `brush`, `select`) through
 * `window.__ggRenderPerf.arm(kind, inputEvent)`, performs it, and takes the
 * recording: timestamped phase events (also written as performance marks
 * `glassgrid:<kind>:<phase>`) and every React commit with its render/commit
 * times, Profiler regions and the components that rendered (with why).
 *
 * Commit inspector: after every commit React calls the hook's
 * `onCommitFiberRoot`; the inspector walks the parts of the fiber tree that
 * were re-rendered and records, per rendered component, its name, Profiler
 * region, own render time and its previous and next props (by reference) and
 * whether its state or context changed. Needed and wasted renders are told
 * apart when the recording is taken, off the measured path.
 */

/** The fiber fields the inspector reads (React internals; stable across React 18-19). */
interface Fiber {
  tag: number;
  type: unknown;
  flags: number;
  child: Fiber | null;
  sibling: Fiber | null;
  alternate: Fiber | null;
  memoizedProps: unknown;
  memoizedState: unknown;
  dependencies: { firstContext: ContextItem | null } | null;
  selfBaseDuration?: number;
}

interface ContextItem {
  memoizedValue: unknown;
  next: ContextItem | null;
}

interface HookState {
  memoizedState: unknown;
  next: HookState | null;
}

interface FiberRoot {
  current: Fiber;
}

/** One rendered component as captured at commit time (props kept by reference, compared later). */
interface RawComponentRender {
  name: string;
  region: string;
  mount: boolean;
  selfMs: number;
  stateChanged: boolean;
  contextChanged: boolean;
  prevProps: unknown;
  nextProps: unknown;
}

interface RawCommit {
  /** onCommitFiberRoot entry time. */
  end: number;
  components: RawComponentRender[];
  inspectMs: number;
}

/** Whether commits are walked (off: measure the inspector's own overhead). */
let inspect = true;

const FUNCTION_COMPONENT = 0;
const CLASS_COMPONENT = 1;
const FORWARD_REF = 11;
const PROFILER = 12;
const SIMPLE_MEMO_COMPONENT = 15;
/** `PerformedWork`: the component's render function ran in this pass. */
const PERFORMED_WORK = 1;

function nameOf(type: unknown): string {
  if (typeof type === 'function') {
    const fn = type as { displayName?: unknown; name?: unknown };
    if (typeof fn.displayName === 'string') return fn.displayName;
    if (typeof fn.name === 'string' && fn.name !== '') return fn.name;
  }
  if (typeof type === 'object' && type !== null && 'render' in type) return nameOf(type.render);
  return 'Anonymous';
}

function isComponent(tag: number): boolean {
  return tag === FUNCTION_COMPONENT || tag === CLASS_COMPONENT || tag === FORWARD_REF || tag === SIMPLE_MEMO_COMPONENT;
}

/** Effects and memo/callback caches are not state: skip them when comparing hook lists. */
function isDerivedHook(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  if ('create' in value && 'deps' in value) return true;
  return Array.isArray(value) && value.length === 2 && (value[1] === null || Array.isArray(value[1]));
}

function stateChanged(fiber: Fiber, previous: Fiber): boolean {
  if (fiber.tag === CLASS_COMPONENT) {
    const a = fiber.memoizedState as Record<string, unknown> | null;
    const b = previous.memoizedState as Record<string, unknown> | null;
    if (a === b) return false;
    if (!a || !b) return true;
    const keys = Object.keys(a);
    return keys.length !== Object.keys(b).length || keys.some((key) => !Object.is(a[key], b[key]));
  }
  let a = fiber.memoizedState as HookState | null;
  let b = previous.memoizedState as HookState | null;
  while (a && b) {
    if (!Object.is(a.memoizedState, b.memoizedState) && !isDerivedHook(a.memoizedState)) return true;
    a = a.next;
    b = b.next;
  }
  return false;
}

function contextChanged(fiber: Fiber, previous: Fiber): boolean {
  let a = fiber.dependencies?.firstContext ?? null;
  let b = previous.dependencies?.firstContext ?? null;
  while (a && b) {
    if (!Object.is(a.memoizedValue, b.memoizedValue)) return true;
    a = a.next;
    b = b.next;
  }
  return false;
}

function visit(first: Fiber | null, region: string, out: RawComponentRender[]): void {
  for (let fiber = first; fiber; fiber = fiber.sibling) {
    const previous = fiber.alternate;
    let inner = region;
    if (fiber.tag === PROFILER) {
      const id = (fiber.memoizedProps as { id?: unknown } | null)?.id;
      if (typeof id === 'string') inner = id;
    }
    if (isComponent(fiber.tag) && (previous === null || (fiber.flags & PERFORMED_WORK) !== 0)) {
      out.push({
        name: nameOf(fiber.type),
        region: inner,
        mount: previous === null,
        selfMs: fiber.selfBaseDuration ?? 0,
        stateChanged: previous !== null && stateChanged(fiber, previous),
        contextChanged: previous !== null && contextChanged(fiber, previous),
        prevProps: previous?.memoizedProps ?? null,
        nextProps: fiber.memoizedProps,
      });
    }
    // A subtree React did not touch keeps the previous child fibers: nothing below re-rendered.
    if (fiber.child && (previous === null || fiber.child !== previous.child)) visit(fiber.child, inner, out);
  }
}

interface Armed {
  kind: string;
  input: string;
  armedAt: number;
  events: RenderPerfEvent[];
  commits: { raw: RawCommit; profiler: ProfilerCommit | null }[];
  chartsBefore: ReadonlySet<string>;
  notified: boolean;
  rendered: boolean;
  /** Results ChartView has rendered (first render of each counts as `data-render`). */
  seenResults: WeakSet<object>;
  /** Engine view of each request sent while armed. */
  views: Map<string, string>;
}

interface ProfilerCommit {
  start: number;
  renderStart: number | null;
  renderMs: number;
  layoutEffectsMs: number | null;
  regions: Record<string, number>;
}

let store: Pick<WorkspaceStore, 'getState'> | null = null;
let armed: Armed | null = null;
let profilerCommit: ProfilerCommit | null = null;
/** A requested animation frame that has not fired yet (new commits and draws join it). */
let frameRequested = false;

function record(type: string, data: Omit<RenderPerfEvent, 't' | 'type'> = {}, t = performance.now()): void {
  const current = armed;
  if (!current) return;
  current.events.push({ t, type, ...data });
  try {
    performance.mark(`${RENDER_PERF_MARK_PREFIX}${current.kind}:${type}`, { startTime: t });
  } catch {
    // A timestamp before the time origin (cannot happen for live events).
  }
}

/** The next animation frame (`raf`) and a task after that frame was rendered (`presented`). */
function requestFrame(): void {
  if (frameRequested || !armed) return;
  frameRequested = true;
  requestAnimationFrame(() => {
    frameRequested = false;
    record('raf');
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      record('presented');
      channel.port1.close();
    };
    channel.port2.postMessage(null);
  });
}

/** `<Profiler onRender>` of every region. */
export function onProfilerRender(id: string, _phase: string, actualDuration: number, _baseDuration: number, startTime: number, commitTime: number): void {
  if (!armed) return;
  let current = profilerCommit;
  if (current?.start !== commitTime) {
    current = { start: commitTime, renderStart: null, renderMs: 0, layoutEffectsMs: null, regions: {} };
    profilerCommit = current;
  }
  current.regions[id] = (current.regions[id] ?? 0) + actualDuration;
  if (id === 'App') {
    current.renderMs = actualDuration;
    current.renderStart = startTime;
  }
}

/** `<Profiler onCommit>` (profiling builds): the root's layout-effect time. */
export function onProfilerCommit(id: string, _phase: string, effectDuration: number, commitTime: number): void {
  if (!armed || id !== 'App' || profilerCommit?.start !== commitTime) return;
  profilerCommit.layoutEffectsMs = effectDuration;
}

function onRawCommit(raw: RawCommit): void {
  const current = armed;
  if (!current) return;
  const profiler = profilerCommit !== null && profilerCommit.start <= raw.end ? profilerCommit : null;
  profilerCommit = null;
  current.commits.push({ raw, profiler });
  record('commit-end', {}, raw.end);
  requestFrame();
}

// ---------------------------------------------------------------------------
// Wasted-render classification (when the recording is taken, not while measuring)

const REACT_ELEMENT = Symbol.for('react.transitional.element');
const LEGACY_REACT_ELEMENT = Symbol.for('react.element');

/** Equal by value; functions count as equal (a new callback identity is what useCallback fixes). */
function sameValue(a: unknown, b: unknown, budget: { left: number }, depth = 0): boolean {
  if (Object.is(a, b)) return true;
  budget.left -= 1;
  if (budget.left < 0 || depth > 8) return false;
  if (typeof a === 'function' && typeof b === 'function') return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => sameValue(item, b[i], budget, depth + 1));
  }
  if (a instanceof Set) return b instanceof Set && a.size === b.size && [...a].every((item) => b.has(item));
  if (a instanceof Map) {
    return b instanceof Map && a.size === b.size && [...a].every(([key, value]) => b.has(key) && sameValue(value, b.get(key), budget, depth + 1));
  }
  const ta = (a as { $$typeof?: unknown }).$$typeof;
  if (ta === REACT_ELEMENT || ta === LEGACY_REACT_ELEMENT) {
    const ea = a as { $$typeof: unknown; type: unknown; key: unknown; props: unknown };
    const eb = b as { $$typeof?: unknown; type?: unknown; key?: unknown; props?: unknown };
    return ea.$$typeof === eb.$$typeof && ea.type === eb.type && ea.key === eb.key && sameValue(ea.props, eb.props, budget, depth + 1);
  }
  const plain = (value: object) => {
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  };
  if (!plain(a) || !plain(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = Object.keys(ra);
  return keys.length === Object.keys(rb).length && keys.every((key) => Object.hasOwn(rb, key) && sameValue(ra[key], rb[key], budget, depth + 1));
}

function classify(raw: RawComponentRender): RenderPerfComponentRender {
  const base = { name: raw.name, region: raw.region, selfMs: raw.selfMs };
  const result = (cause: RenderCause, wasted: boolean, changed?: string[]): RenderPerfComponentRender => ({
    ...base,
    cause,
    wasted,
    ...(changed && changed.length > 0 ? { changed: changed.slice(0, 8) } : {}),
  });
  if (raw.mount) return result('mount', false);
  if (raw.stateChanged) return result('state', false);
  if (raw.contextChanged) return result('context', false);
  const prev = (raw.prevProps ?? {}) as Record<string, unknown>;
  const next = (raw.nextProps ?? {}) as Record<string, unknown>;
  const changed = [...new Set([...Object.keys(prev), ...Object.keys(next)])].filter((key) => !Object.is(prev[key], next[key]));
  if (changed.length === 0) return result('same-props', true);
  const budget = { left: 20_000 };
  const byValue = changed.every((key) => sameValue(prev[key], next[key], budget));
  return byValue ? result('unstable-props', true, changed) : result('props', false, changed.filter((key) => !sameValue(prev[key], next[key], { left: 20_000 })));
}

function finish(current: Armed): RenderPerfRecording {
  const commits: RenderPerfCommit[] = current.commits.map(({ raw, profiler }) => ({
    start: profiler?.start ?? raw.end,
    renderStart: profiler?.renderStart ?? null,
    renderMs: profiler?.renderMs ?? 0,
    end: raw.end,
    layoutEffectsMs: profiler?.layoutEffectsMs ?? null,
    regions: profiler?.regions ?? {},
    components: raw.components.map(classify),
    inspectMs: raw.inspectMs,
  }));
  return { kind: current.kind, armedAt: current.armedAt, events: current.events, commits };
}

// ---------------------------------------------------------------------------
// What the app calls (always behind `if (__GG_RENDER_PERF__)`)

export const renderPerf = {
  event: record,

  /** The app is about to dispatch the interaction's command. */
  dispatch(): void {
    record('dispatch');
  },

  /** App rendered with these charts: the first render after the store notified. */
  appRender(chartIds: readonly { id: string }[]): void {
    const current = armed;
    if (!current?.notified || current.rendered) return;
    current.rendered = true;
    const added = chartIds.find((chart) => !current.chartsBefore.has(chart.id));
    record('render', added ? { chartId: added.id } : {});
  },

  /** ChartView rendered `result` (first time for that result: a new aggregate on screen). */
  chartResult(chartId: string, result: object): void {
    const current = armed;
    if (!current || current.seenResults.has(result)) return;
    current.seenResults.add(result);
    record('data-render', { chartId });
  },

  /** Runs `work` and records its duration as `type` (e.g. `adapt`) for `chartId`. */
  timed<T>(type: string, chartId: string, work: () => T): T {
    const start = performance.now();
    const result = work();
    record(type, { chartId, ms: performance.now() - start });
    return result;
  },

  drawn(chartId: string): void {
    record('drawn', { chartId });
    requestFrame();
  },

  query(view: string): void {
    record('query', { view });
  },

  resolved(view: string): void {
    record('resolved', { view });
  },

  request(request: { requestId: string; kind: string; viewId?: string }): void {
    const current = armed;
    if (!current) return;
    const view = request.viewId ?? request.kind;
    current.views.set(request.requestId, view);
    record('request', { requestId: request.requestId, requestKind: request.kind, view });
  },

  /** A raw engine port message (before validation). */
  reply(raw: unknown): void {
    const current = armed;
    if (!current || typeof raw !== 'object' || raw === null) return;
    const message = raw as { requestId?: unknown; kind?: unknown; engineMs?: unknown; cached?: unknown; ipc?: unknown };
    if (typeof message.requestId !== 'string') return;
    const view = current.views.get(message.requestId);
    if (view === undefined) return;
    record('reply', {
      requestId: message.requestId,
      view,
      ...(typeof message.kind === 'string' ? { requestKind: message.kind } : {}),
      ...(typeof message.engineMs === 'number' ? { engineMs: message.engineMs } : {}),
      ...(typeof message.cached === 'boolean' ? { cached: message.cached } : {}),
      ...(message.ipc instanceof Uint8Array ? { bytes: message.ipc.byteLength } : {}),
    });
  },

  validated(requestId: string): void {
    const view = armed?.views.get(requestId);
    if (view !== undefined) record('validated', { requestId, view });
  },

  decoded(requestId: string, ms: number): void {
    const view = armed?.views.get(requestId);
    if (view !== undefined) record('decoded', { requestId, view, ms });
  },
};

export interface RenderPerfApi {
  /** Start recording one interaction; `input` is the DOM event type that starts it (`drop`, `pointerdown`, `pointerup`, `keydown`). */
  arm(kind: string, input: string): void;
  /** Stop recording and return it. */
  take(): RenderPerfRecording | null;
  /** Turn the per-commit component walk off (to measure its overhead) or on. */
  setInspect(on: boolean): void;
}

declare global {
  /**
   * Build-time flag (each shell's Vite `define`): true only in
   * `GLASSGRID_RENDER_PERF=1` builds, which compile in this module and
   * render-perf.ts. Declared here, the module every user of the flag imports.
   */
  const __GG_RENDER_PERF__: boolean;

  interface Window {
    __ggRenderPerf?: RenderPerfApi;
  }
}

/** Installs the recorder and `window.__ggRenderPerf` (render-perf.ts, before the first render). */
export function installRecorder(workspaceStore: Pick<WorkspaceStore, 'subscribe' | 'getState'>): void {
  store = workspaceStore;
  workspaceStore.subscribe(() => {
    const current = armed;
    if (!current || current.notified) return;
    current.notified = true;
    record('notify');
  });
  for (const type of ['drop', 'pointerdown', 'pointerup', 'keydown']) {
    window.addEventListener(
      type,
      (event) => {
        const current = armed;
        if (!current || current.input !== event.type || current.events.some((entry) => entry.type === 'input')) return;
        record('input', { name: event.type }, event.timeStamp);
      },
      { capture: true },
    );
  }
  window.__ggRenderPerf = {
    arm(kind, input) {
      profilerCommit = null;
      armed = {
        kind,
        input,
        armedAt: performance.now(),
        events: [],
        commits: [],
        chartsBefore: new Set(store?.getState().charts.map((chart) => chart.id) ?? []),
        notified: false,
        rendered: false,
        seenResults: new WeakSet(),
        views: new Map(),
      };
    },
    take() {
      const current = armed;
      armed = null;
      if (!current) return null;
      for (const entry of performance.getEntriesByType('mark')) {
        if (entry.name.startsWith(`${RENDER_PERF_MARK_PREFIX}${current.kind}:`)) performance.clearMarks(entry.name);
      }
      return finish(current);
    },
    setInspect(on) {
      inspect = on;
    },
  };
}

if (__GG_RENDER_PERF__) {
  const hook = {
    supportsFiber: true,
    renderers: new Map<number, unknown>(),
    inject(internals: unknown): number {
      hook.renderers.set(1, internals);
      return 1;
    },
    checkDCE(): void {},
    onScheduleFiberRoot(): void {},
    onCommitFiberUnmount(): void {},
    onPostCommitFiberRoot(): void {},
    onCommitFiberRoot(_rendererId: number, root: FiberRoot): void {
      if (!armed) return;
      const end = performance.now();
      const components: RawComponentRender[] = [];
      if (inspect) visit(root.current.child, 'App', components);
      onRawCommit({ end, components, inspectMs: performance.now() - end });
    },
  };
  (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ ??= hook;
}

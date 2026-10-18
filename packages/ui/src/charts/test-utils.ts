import { act } from '@testing-library/react';
import { vi } from 'vitest';
import { resetMeasuringContext } from './canvas.js';

/*
 * Test helpers: a recording 2D context (every method call and style
 * assignment, in order) and manual animation frames.
 */

export type Call = readonly [string, ...unknown[]];

export interface RecordingContext {
  readonly calls: Call[];
  readonly canvas: HTMLCanvasElement | null;
  /** Calls of one method. */
  named(name: string): Call[];
  /** Style assignments and method calls up to (excluding) the n-th call of `name`. */
  styleAt(property: string, callIndex: number): unknown;
  reset(): void;
}

const STATE_DEFAULTS: Record<string, unknown> = {
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  font: '10px sans-serif',
  textAlign: 'start',
  textBaseline: 'alphabetic',
  globalAlpha: 1,
  lineJoin: 'miter',
  lineCap: 'butt',
};

/** A Proxy that records every call and assignment; `measureText` is 6 px per character. */
export function recordingContext(canvas: HTMLCanvasElement | null = null): RecordingContext & CanvasRenderingContext2D {
  const calls: Call[] = [];
  const state: Record<string, unknown> = { ...STATE_DEFAULTS };
  const stack: Record<string, unknown>[] = [];
  const base: RecordingContext = {
    calls,
    canvas,
    named: (name) => calls.filter((c) => c[0] === name),
    styleAt: (property, callIndex) => {
      let value = STATE_DEFAULTS[property];
      for (let i = 0; i < callIndex && i < calls.length; i += 1) {
        const call = calls[i];
        if (call?.[0] === property) value = call[1];
      }
      return value;
    },
    reset: () => {
      calls.length = 0;
    },
  };
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    measureText: (text) => ({ width: String(text).length * 6 }),
    save: () => {
      stack.push({ ...state });
      calls.push(['save']);
    },
    restore: () => {
      Object.assign(state, stack.pop() ?? {});
      calls.push(['restore']);
    },
    getTransform: () => ({ a: 1, d: 1 }),
  };
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return (target as unknown as Record<string, unknown>)[prop];
      if (prop in state) return state[prop];
      const method = methods[prop];
      if (method) return method;
      return (...args: unknown[]) => {
        calls.push([prop, ...args]);
      };
    },
    set(_, prop, value: unknown) {
      if (typeof prop !== 'string') return false;
      state[prop] = value;
      calls.push([prop, value]);
      return true;
    },
  }) as RecordingContext & CanvasRenderingContext2D;
}

/** Installs recording contexts for every canvas (by element) and manual animation frames. */
export function installCanvasRecorder() {
  const contexts = new Map<HTMLCanvasElement, RecordingContext & CanvasRenderingContext2D>();
  let frames: FrameRequestCallback[] = [];
  resetMeasuringContext();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, kind: string) {
    if (kind !== '2d') return null;
    let ctx = contexts.get(this);
    if (!ctx) {
      ctx = recordingContext(this);
      contexts.set(this, ctx);
    }
    return ctx;
  } as typeof HTMLCanvasElement.prototype.getContext);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  return {
    contexts,
    contextOf(canvas: Element | null): RecordingContext & CanvasRenderingContext2D {
      const ctx = canvas ? contexts.get(canvas as HTMLCanvasElement) : undefined;
      if (!ctx) throw new Error('no recording context for that canvas');
      return ctx;
    },
    flushFrames() {
      act(() => {
        for (let i = 0; i < 5 && frames.length > 0; i += 1) {
          const queued = frames;
          frames = [];
          for (const callback of queued) callback(performance.now());
        }
      });
    },
    pendingFrames: () => frames.length,
  };
}

/** jsdom does no layout: give elements matching `selector` a client size. */
export function mockClientSize(selector: string, width: number, height: number): void {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.matches(selector) ? width : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.matches(selector) ? height : 0;
  });
}

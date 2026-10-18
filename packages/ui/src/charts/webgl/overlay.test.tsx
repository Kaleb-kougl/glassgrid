import { act, render, screen } from '@testing-library/react';
import { Float64, Table, vectorFromArray } from 'apache-arrow';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvedTokens } from '../../tokens.js';
import { chartColumnsFromArrow } from '../arrow.js';
import { ScatterChart } from '../ScatterChart.js';
import { installCanvasRecorder, mockClientSize } from '../test-utils.js';
import { WebGLOverlayManager, computeViewport, isSoftwareRenderer, type OverlayClient, type OverlayEnvironment } from './overlay.js';
import { ScatterGLClient, scatterInstances } from './scatter.js';
import { WebGLOverlayProvider } from './WebGLOverlayProvider.js';

type GLCall = [string, ...unknown[]];

/** A fake WebGL2 context: records calls, hands out tokens for objects, compiles everything. */
function fakeGL() {
  const calls: GLCall[] = [];
  let lost = false;
  const constants: Record<string, number> = {
    SCISSOR_TEST: 0xc11,
    BLEND: 0xbe2,
    COLOR_BUFFER_BIT: 0x4000,
    ONE: 1,
    ONE_MINUS_SRC_ALPHA: 0x303,
    ARRAY_BUFFER: 0x8892,
    STATIC_DRAW: 0x88e4,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    TRIANGLE_STRIP: 5,
    POINTS: 0,
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
  };
  let id = 0;
  const gl = new Proxy(
    {},
    {
      get(_, prop: string) {
        if (prop in constants) return constants[prop];
        if (prop === 'calls') return calls;
        if (prop === 'lose') return () => (lost = true);
        if (prop === 'restore') return () => (lost = false);
        if (prop === 'isContextLost') return () => lost;
        if (prop === 'getShaderParameter' || prop === 'getProgramParameter') return () => true;
        if (prop.startsWith('create') || prop === 'getUniformLocation') return (...args: unknown[]) => ({ id: ++id, kind: prop, args });
        return (...args: unknown[]) => {
          calls.push([prop, ...args]);
        };
      },
    },
  ) as WebGL2RenderingContext & { calls: GLCall[]; lose(): void; restore(): void };
  return gl;
}

function environment(gl: WebGL2RenderingContext | null, dpr = 1) {
  const frames: (() => void)[] = [];
  const getContext = vi.fn(() => gl);
  const env: OverlayEnvironment = {
    getContext,
    requestFrame: (callback) => frames.push(callback),
    cancelFrame: () => undefined,
    devicePixelRatio: () => dpr,
  };
  const flush = () => {
    while (frames.length > 0) frames.shift()?.();
  };
  return { env, getContext, frames, flush };
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

function client(r: { left: number; top: number; width: number; height: number } | null) {
  const draw = vi.fn<(gl: WebGL2RenderingContext) => void>();
  const availability = vi.fn<(available: boolean) => void>();
  const contextLost = vi.fn<() => void>();
  const overlayClient: OverlayClient = { rect: () => r, draw, availability, contextLost };
  return { client: overlayClient, draw, availability, contextLost };
}

describe('computeViewport', () => {
  const overlay = { left: 0, top: 0, width: 800, height: 600 };

  it('places a client in GL coordinates (device px, origin bottom-left)', () => {
    expect(computeViewport(overlay, { left: 100, top: 50, width: 200, height: 100 }, 2, 1600, 1200)).toEqual({
      x: 200,
      y: 900,
      width: 400,
      height: 200,
      scissor: { x: 200, y: 900, width: 400, height: 200 },
    });
  });

  it('scissors a client scrolled partly out of the panel, and skips one fully out', () => {
    const vp = computeViewport(overlay, { left: 100, top: -30, width: 200, height: 100 }, 1, 800, 600);
    expect(vp).toMatchObject({ y: 530, height: 100, scissor: { x: 100, y: 530, width: 200, height: 70 } });
    expect(computeViewport(overlay, { left: 100, top: 700, width: 200, height: 100 }, 1, 800, 600)).toBeNull();
    expect(computeViewport(overlay, { left: 0, top: 0, width: 0, height: 10 }, 1, 800, 600)).toBeNull();
    // A narrower clip (the panel's visible area).
    const clipped = computeViewport(overlay, { left: 100, top: 50, width: 200, height: 100 }, 1, 800, 600, { left: 0, top: 80, width: 800, height: 200 });
    expect(clipped?.scissor).toEqual({ x: 100, y: 450, width: 200, height: 70 });
  });

  it('allocates non-overlapping viewports for cards stacked in a panel', () => {
    const cards = [0, 1, 2].map((i) => computeViewport(overlay, { left: 20, top: 20 + i * 200, width: 300, height: 150 }, 1, 800, 600));
    expect(cards.map((c) => c?.scissor.y)).toEqual([430, 230, 30]);
    expect(cards.map((c) => c?.scissor.height)).toEqual([150, 150, 150]);
  });
});

describe('WebGLOverlayManager', () => {
  let canvas: HTMLCanvasElement;
  beforeEach(() => {
    canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 800, 600));
  });

  it('draws every visible client in its own viewport and scissor, in one coalesced frame', () => {
    const gl = fakeGL();
    const { env, frames, flush } = environment(gl, 2);
    const manager = new WebGLOverlayManager(env);
    manager.attach(canvas);
    const a = client({ left: 10, top: 10, width: 100, height: 50 });
    const b = client({ left: 10, top: 300, width: 100, height: 50 });
    const hidden = client(null);
    manager.register(a.client);
    manager.register(b.client);
    manager.register(hidden.client);
    manager.invalidate();
    expect(frames).toHaveLength(1);
    flush();
    expect(canvas.width).toBe(1600);
    expect(canvas.height).toBe(1200);
    expect(a.draw).toHaveBeenCalledTimes(1);
    expect(b.draw).toHaveBeenCalledTimes(1);
    expect(hidden.draw).not.toHaveBeenCalled();
    const viewports = gl.calls.filter((c) => c[0] === 'viewport').slice(1);
    expect(viewports).toEqual([
      ['viewport', 20, 1080, 200, 100],
      ['viewport', 20, 500, 200, 100],
    ]);
    expect(gl.calls.filter((c) => c[0] === 'scissor')).toHaveLength(2);
    expect(manager.lastFrame.drawn).toBe(2);
    expect(a.availability).toHaveBeenCalledWith(true);
  });

  it('reports WebGL unavailable when there is no context, and draws nothing', () => {
    const { env, flush } = environment(null);
    const manager = new WebGLOverlayManager(env);
    manager.attach(canvas);
    const a = client({ left: 0, top: 0, width: 10, height: 10 });
    manager.register(a.client);
    flush();
    expect(manager.available).toBe(false);
    expect(a.availability).toHaveBeenLastCalledWith(false);
    expect(a.draw).not.toHaveBeenCalled();
  });

  it('falls back on context loss and recovers on restore', () => {
    const gl = fakeGL();
    const { env, flush } = environment(gl);
    const manager = new WebGLOverlayManager(env);
    manager.attach(canvas);
    const a = client({ left: 0, top: 0, width: 10, height: 10 });
    manager.register(a.client);
    expect(manager.resource('program', () => ({ compiled: true }))).toEqual({ compiled: true });
    const lost = new Event('webglcontextlost', { cancelable: true });
    gl.lose();
    canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(manager.available).toBe(false);
    expect(a.availability).toHaveBeenLastCalledWith(false);
    expect(a.contextLost).toHaveBeenCalledTimes(1);
    expect(manager.resource('program', () => ({ compiled: true }))).toBeNull();
    flush();
    expect(a.draw).not.toHaveBeenCalled();
    gl.restore();
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(manager.available).toBe(true);
    expect(a.availability).toHaveBeenLastCalledWith(true);
    flush();
    expect(a.draw).toHaveBeenCalledTimes(1);
  });

  it('treats a failing draw (e.g. a shader that does not compile) as WebGL unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { env, flush } = environment(fakeGL());
    const manager = new WebGLOverlayManager(env);
    manager.attach(canvas);
    const a = client({ left: 0, top: 0, width: 10, height: 10 });
    a.draw.mockImplementation(() => {
      throw new Error('shader');
    });
    manager.register(a.client);
    flush();
    expect(manager.available).toBe(false);
    expect(a.availability).toHaveBeenLastCalledWith(false);
    expect(warn).toHaveBeenCalled();
  });
});

describe('ScatterGLClient', () => {
  it('uploads instances once and draws all points in one instanced call; the brush is a uniform', () => {
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 800, 600));
    const gl = fakeGL();
    const { env, flush } = environment(gl);
    const manager = new WebGLOverlayManager(env);
    manager.attach(canvas);
    const scatter = new ScatterGLClient(manager, () => undefined);
    manager.register(scatter);
    const element = document.createElement('div');
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(rect(50, 60, 300, 200));
    scatter.setPlacement(element, { left: 30, top: 8, width: 258, height: 170 });
    const data = chartColumnsFromArrow(new Table({ x: vectorFromArray([1, 2, 3], new Float64()), y: vectorFromArray([3, 4, 5], new Float64()) }), 'scatter');
    const instances = scatterInstances(data, ['#2f6db3']);
    expect(Array.from(instances.positions)).toEqual([0, 0, 1, 1, 2, 2]);
    expect(Array.from(instances.colors.subarray(0, 4))).toEqual([0x2f, 0x6d, 0xb3, 255]);
    scatter.setInstances(instances);
    scatter.setView({ xDomain: [0, 4], yDomain: [2, 6], brush: { x0: 1, x1: 2, y0: 3, y1: 4 }, radius: 2, opacity: 0.8, dimOpacity: 0.32 });
    flush();
    const draws = gl.calls.filter((c) => c[0] === 'drawArraysInstanced');
    expect(draws).toEqual([['drawArraysInstanced', gl.TRIANGLE_STRIP, 0, 4, 3]]);
    expect(gl.calls.find((c) => c[0] === 'viewport' && c[1] === 80)).toEqual(['viewport', 80, 600 - 238, 258, 170]);
    expect(gl.calls.filter((c) => c[0] === 'uniform1i').at(-1)?.[2]).toBe(2);
    const uploads = gl.calls.filter((c) => c[0] === 'bufferData').length;
    // Moving the brush: uniforms only, no new buffers.
    scatter.setView({ xDomain: [0, 4], yDomain: [2, 6], brush: null, radius: 2, opacity: 0.8, dimOpacity: 0.32 });
    flush();
    expect(gl.calls.filter((c) => c[0] === 'bufferData').length).toBe(uploads);
    expect(gl.calls.filter((c) => c[0] === 'uniform1i').at(-1)?.[2]).toBe(0);
    expect(scatter.draws).toBe(2);

    // Software renderers: the same buffers, one non-instanced POINTS draw (re-uploaded without divisors).
    manager.setScatterStrategy('points');
    flush();
    expect(gl.calls.filter((c) => c[0] === 'drawArrays').at(-1)).toEqual(['drawArrays', gl.POINTS, 0, 3]);
    expect(gl.calls.filter((c) => c[0] === 'vertexAttribDivisor').slice(-2)).toEqual([
      ['vertexAttribDivisor', 1, 0],
      ['vertexAttribDivisor', 2, 0],
    ]);
  });

  it('detects software renderers', () => {
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe(true);
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(isSoftwareRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)')).toBe(false);
  });
});

describe('WebGLOverlayProvider', () => {
  const big = (n: number) =>
    new Table({
      x: vectorFromArray(Array.from({ length: n }, (_, i) => i), new Float64()),
      y: vectorFromArray(Array.from({ length: n }, (_, i) => i % 13), new Float64()),
    });

  it('gives every dense scatter in the panel the same single WebGL context', () => {
    const recorder = installCanvasRecorder();
    mockClientSize('.gg-chart__plot', 400, 160);
    // jsdom does no layout: the panel is 800×1000, every chart canvas sits at its top-left.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.matches('.gg-webgl-overlay, .gg-webgl-overlay-root') ? rect(0, 0, 800, 1000) : rect(0, 0, 400, 160);
    });
    const gl = fakeGL();
    const { env, getContext, flush } = environment(gl);
    const table = big(50);
    render(
      <WebGLOverlayProvider environment={env} testId="panel">
        <ScatterChart table={table} tokens={resolvedTokens.light} label="A" xLabel="x" yLabel="y" webglThreshold={10} testId="a" />
        <ScatterChart table={table} tokens={resolvedTokens.light} label="B" xLabel="x" yLabel="y" webglThreshold={10} testId="b" />
        <ScatterChart table={big(5)} tokens={resolvedTokens.light} label="C" xLabel="x" yLabel="y" webglThreshold={10} testId="c" />
      </WebGLOverlayProvider>,
    );
    act(() => {
      recorder.flushFrames();
      flush();
    });
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('panel').querySelectorAll('canvas.gg-webgl-overlay')).toHaveLength(1);
    expect(gl.calls.filter((c) => c[0] === 'drawArraysInstanced').map((c) => c[4])).toEqual([50, 50]);
    // Dense charts leave their marks to the overlay; the small one draws its own points.
    const marksDrawn = (testId: string) => {
      const base = screen.getByTestId(`${testId}-plot`).querySelector('.gg-chart__base');
      return recorder.contextOf(base).calls.filter((c) => c[0] === 'drawImage').length;
    };
    expect(marksDrawn('a')).toBeLessThan(marksDrawn('c'));
  });

  it('falls back to Canvas 2D when WebGL is unavailable', () => {
    const recorder = installCanvasRecorder();
    mockClientSize('.gg-chart__plot', 400, 160);
    const { env, flush } = environment(null);
    render(
      <WebGLOverlayProvider environment={env}>
        <ScatterChart table={big(50)} tokens={resolvedTokens.light} label="A" xLabel="x" yLabel="y" webglThreshold={10} testId="a" />
      </WebGLOverlayProvider>,
    );
    act(() => {
      recorder.flushFrames();
      flush();
    });
    // Marks are drawn into the chart's own layer: 50 circles.
    const arcs = [...recorder.contexts.values()].reduce((n, ctx) => n + ctx.named('arc').length, 0);
    expect(arcs).toBe(50);
  });
});

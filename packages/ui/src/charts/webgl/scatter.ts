import { parseColor } from '../colors.js';
import type { ChartColumns } from '../types.js';
import type { PlotRect } from '../axes.js';
import type { GLViewport, OverlayClient, RectLike, WebGLOverlayManager } from './overlay.js';

/*
 * Instanced scatter renderer: one draw call for all points. A unit quad
 * (4 vertices) is instanced once per point; each instance carries its
 * position (float32, relative to an origin so epoch-ms times keep their
 * precision) and its colour (RGBA8). Domain, brush and opacity are
 * uniforms, so panning a brush redraws without touching the buffers.
 */

const VERTEX = `#version 300 es
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_pos;
layout(location = 2) in vec4 a_color;
uniform vec4 u_domain;
uniform vec2 u_viewport;
uniform float u_radius;
uniform vec4 u_brush;
uniform int u_brushOn;
uniform float u_dim;
uniform float u_alpha;
out vec4 v_color;
out vec2 v_local;
void main() {
  vec2 t = (a_pos - u_domain.xz) / (u_domain.yw - u_domain.xz);
  vec2 clip = t * 2.0 - 1.0 + a_corner * (u_radius + 1.0) * 2.0 / u_viewport;
  gl_Position = vec4(clip, 0.0, 1.0);
  bool inside = true;
  if (u_brushOn >= 1) inside = a_pos.x >= u_brush.x && a_pos.x <= u_brush.y;
  if (u_brushOn == 2) inside = inside && a_pos.y >= u_brush.z && a_pos.y <= u_brush.w;
  float a = a_color.a * u_alpha * (inside ? 1.0 : u_dim);
  v_color = vec4(a_color.rgb * a, a);
  v_local = a_corner * (u_radius + 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec4 v_color;
in vec2 v_local;
uniform float u_radius;
out vec4 outColor;
void main() {
  float cover = clamp(u_radius + 0.5 - length(v_local), 0.0, 1.0);
  if (cover <= 0.0) discard;
  outColor = v_color * cover;
}`;

export interface ScatterProgram {
  readonly program: WebGLProgram;
  readonly quad: WebGLBuffer;
  readonly uniforms: Readonly<Record<'domain' | 'viewport' | 'radius' | 'brush' | 'brushOn' | 'dim' | 'alpha', WebGLUniformLocation | null>>;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL: createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`WebGL shader: ${gl.getShaderInfoLog(shader) ?? 'compile failed'}`);
  return shader;
}

export function createScatterProgram(gl: WebGL2RenderingContext): ScatterProgram {
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL program: ${gl.getProgramInfoLog(program) ?? 'link failed'}`);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const u = (name: string) => gl.getUniformLocation(program, name);
  return {
    program,
    quad,
    uniforms: {
      domain: u('u_domain'),
      viewport: u('u_viewport'),
      radius: u('u_radius'),
      brush: u('u_brush'),
      brushOn: u('u_brushOn'),
      dim: u('u_dim'),
      alpha: u('u_alpha'),
    },
  };
}

/** Per-point instance data: positions relative to `origin`, RGBA8 colours. */
export interface ScatterInstances {
  readonly count: number;
  readonly origin: readonly [number, number];
  readonly positions: Float32Array;
  readonly colors: Uint8Array;
}

/** Instance buffers for a scatter result, colours from the series palette. */
export function scatterInstances(data: ChartColumns, colors: readonly string[]): ScatterInstances {
  const n = data.length;
  let ox = Infinity;
  let oy = Infinity;
  for (let i = 0; i < n; i += 1) {
    const x = data.x[i] ?? Number.NaN;
    const y = data.y[i] ?? Number.NaN;
    if (x < ox) ox = x;
    if (y < oy) oy = y;
  }
  if (!Number.isFinite(ox)) ox = 0;
  if (!Number.isFinite(oy)) oy = 0;
  const positions = new Float32Array(n * 2);
  const rgba = new Uint8Array(n * 4);
  const parsed = colors.map(parseColor);
  for (let i = 0; i < n; i += 1) {
    positions[i * 2] = (data.x[i] ?? Number.NaN) - ox;
    positions[i * 2 + 1] = (data.y[i] ?? Number.NaN) - oy;
    const [r, g, b] = parsed[data.series ? (data.series[i] ?? 0) : 0] ?? parsed[0] ?? [0, 0, 0];
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return { count: n, origin: [ox, oy], positions, colors: rgba };
}

/** What the scatter shows this frame (data units; the brush may be null). */
export interface ScatterView {
  readonly xDomain: readonly [number, number];
  readonly yDomain: readonly [number, number];
  readonly brush: { readonly x0: number; readonly x1: number; readonly y0?: number; readonly y1?: number } | null;
  /** CSS px. */
  readonly radius: number;
  readonly opacity: number;
  readonly dimOpacity: number;
}

/** A scatter drawn on the shared overlay. */
export class ScatterGLClient implements OverlayClient {
  private instances: ScatterInstances | null = null;
  private view: ScatterView | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private positionBuffer: WebGLBuffer | null = null;
  private colorBuffer: WebGLBuffer | null = null;
  private uploaded: ScatterInstances | null = null;
  private readonly manager: WebGLOverlayManager;
  private readonly onAvailability: (available: boolean) => void;
  private element: Element | null = null;
  private plot: PlotRect | null = null;
  /** Draws issued (for tests and the benchmark). */
  draws = 0;

  constructor(manager: WebGLOverlayManager, onAvailability: (available: boolean) => void) {
    this.manager = manager;
    this.onAvailability = onAvailability;
  }

  /** Where the plot is: the chart's canvas and the plot rectangle inside it (CSS px). */
  setPlacement(element: Element | null, plot: PlotRect | null): void {
    this.element = element;
    this.plot = plot;
    this.manager.invalidate();
  }

  private getRect(): RectLike | null {
    const { element, plot } = this;
    if (!element || !plot) return null;
    const rect = element.getBoundingClientRect();
    return { left: rect.left + plot.left, top: rect.top + plot.top, width: plot.width, height: plot.height };
  }

  setInstances(instances: ScatterInstances | null): void {
    this.instances = instances;
    this.manager.invalidate();
  }

  setView(view: ScatterView | null): void {
    this.view = view;
    this.manager.invalidate();
  }

  rect(): RectLike | null {
    return this.instances && this.view ? this.getRect() : null;
  }

  availability(available: boolean): void {
    this.onAvailability(available);
  }

  contextLost(): void {
    this.gl = null;
    this.vao = null;
    this.positionBuffer = null;
    this.colorBuffer = null;
    this.uploaded = null;
  }

  private upload(gl: WebGL2RenderingContext, program: ScatterProgram, instances: ScatterInstances): void {
    if (this.gl !== gl) {
      this.contextLost();
      this.gl = gl;
    }
    this.vao ??= gl.createVertexArray();
    this.positionBuffer ??= gl.createBuffer();
    this.colorBuffer ??= gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, program.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances.colors, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 0, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
    this.uploaded = instances;
  }

  draw(gl: WebGL2RenderingContext, viewport: GLViewport): void {
    const instances = this.instances;
    const view = this.view;
    if (!instances || !view || instances.count === 0) return;
    const program = this.manager.resource('scatter-program', createScatterProgram);
    if (!program) return;
    if (this.uploaded !== instances || this.gl !== gl) this.upload(gl, program, instances);
    const dpr = viewport.width / Math.max(1, this.getRect()?.width ?? viewport.width);
    const [ox, oy] = instances.origin;
    const { uniforms } = program;
    gl.useProgram(program.program);
    gl.uniform4f(uniforms.domain, view.xDomain[0] - ox, view.xDomain[1] - ox, view.yDomain[0] - oy, view.yDomain[1] - oy);
    gl.uniform2f(uniforms.viewport, viewport.width, viewport.height);
    gl.uniform1f(uniforms.radius, view.radius * dpr);
    gl.uniform1f(uniforms.alpha, view.opacity);
    gl.uniform1f(uniforms.dim, view.dimOpacity);
    const brush = view.brush;
    if (brush) {
      const has2d = brush.y0 !== undefined && brush.y1 !== undefined;
      gl.uniform4f(uniforms.brush, brush.x0 - ox, brush.x1 - ox, (brush.y0 ?? 0) - oy, (brush.y1 ?? 0) - oy);
      gl.uniform1i(uniforms.brushOn, has2d ? 2 : 1);
    } else {
      gl.uniform1i(uniforms.brushOn, 0);
    }
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, instances.count);
    gl.bindVertexArray(null);
    this.draws += 1;
  }

  dispose(): void {
    const gl = this.gl;
    if (gl && !gl.isContextLost()) {
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.positionBuffer) gl.deleteBuffer(this.positionBuffer);
      if (this.colorBuffer) gl.deleteBuffer(this.colorBuffer);
    }
    this.contextLost();
  }
}

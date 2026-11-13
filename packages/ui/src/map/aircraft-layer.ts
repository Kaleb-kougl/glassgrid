import type { CustomLayerInterface, CustomRenderMethodInput, Map as MapLibreMap } from 'maplibre-gl';
import { relativeMatrix, ORIGIN_X, ORIGIN_Y } from './mercator.js';
import { VERTEX_BYTES, type AircraftScene, type VertexData } from './scene.js';
import { recordLayerFrame } from './stats.js';

/*
 * The aircraft and their trails, drawn into MapLibre's own WebGL2 context
 * as a custom layer (CustomLayerInterface), above the basemap.
 *
 * - Trails: one indexed draw of screen-space extruded quads (2 CSS px wide),
 *   fading with age in the vertex shader (`u_now` is a uniform, so the
 *   static trail buffer is uploaded only when rows change), plus the
 *   connectors from each trail's last point to the drawn aircraft.
 * - The selected aircraft's track (L4, `selectedTrack`): the trail program
 *   again, wider and opaque in the selection colour (its vertex times equal
 *   `u_now`, so nothing fades), above the trails and below the glyphs.
 * - Glyphs: one indexed draw of quads; the fragment shader draws a plane
 *   (or a ring for ground traffic) as a signed distance field with an
 *   outline, rotated by track on the GPU; the selected aircraft is bigger
 *   and ringed. Positions come from the scene on the CPU every frame (dead
 *   reckoning), 32 bytes per vertex.
 *
 * Plain (non-instanced) indexed draws: the chart overlay measured instanced
 * draws at ~17 µs per instance on SwiftShader (docs/m3-charts.md), and the
 * vertex counts here are small. Positions are relative to ORIGIN with the
 * translation folded into the matrix in float64 (mercator.ts), so glyphs do
 * not jitter at high zoom.
 */

const GLYPH_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_corner;
layout(location = 2) in float a_angle;
layout(location = 3) in float a_radius;
layout(location = 4) in float a_kind;
layout(location = 5) in vec4 a_color;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_pixelRatio;
out vec2 v_local;
out vec4 v_color;
out float v_kind;
out float v_px;
void main() {
  vec4 c = u_matrix * vec4(a_pos, 0.0, 1.0);
  float s = sin(a_angle);
  float k = cos(a_angle);
  // Clockwise rotation by the track: local +y is the nose, clip +y is screen-up.
  vec2 r = vec2(a_corner.x * k + a_corner.y * s, -a_corner.x * s + a_corner.y * k);
  float px = a_radius * u_pixelRatio;
  c.xy += r * px * 2.0 / u_viewport * c.w;
  gl_Position = c;
  v_local = a_corner;
  v_color = a_color;
  v_kind = a_kind;
  v_px = px;
}`;

const GLYPH_FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_local;
in vec4 v_color;
in float v_kind;
in float v_px;
uniform vec3 u_outline;
uniform vec3 u_selection;
out vec4 outColor;

float sdQuad(vec2 p, vec2 a, vec2 b, vec2 c, vec2 d) {
  vec2 v[4] = vec2[4](a, b, c, d);
  float dist = dot(p - v[0], p - v[0]);
  float sgn = 1.0;
  for (int i = 0, j = 3; i < 4; j = i, i++) {
    vec2 e = v[j] - v[i];
    vec2 w = p - v[i];
    vec2 q = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    dist = min(dist, dot(q, q));
    bvec3 cond = bvec3(p.y >= v[i].y, p.y < v[j].y, e.x * w.y > e.y * w.x);
    if (all(cond) || all(not(cond))) sgn = -sgn;
  }
  return sgn * sqrt(dist);
}

float sdCapsule(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

float plane(vec2 p) {
  float body = sdCapsule(p, vec2(0.0, -0.72), vec2(0.0, 0.78), 0.12);
  float wings = sdQuad(p, vec2(-0.92, -0.12), vec2(0.92, -0.12), vec2(0.13, 0.30), vec2(-0.13, 0.30));
  float tail = sdQuad(p, vec2(-0.38, -0.86), vec2(0.38, -0.86), vec2(0.09, -0.62), vec2(-0.09, -0.62));
  return min(body, min(wings, tail));
}

void main() {
  float selected = v_kind >= 2.0 ? 1.0 : 0.0;
  float ring = mod(v_kind, 2.0) >= 1.0 ? 1.0 : 0.0;
  vec2 p = v_local;
  // Distances in quad units (1 = the glyph radius); px converts.
  float d = ring > 0.5 ? abs(length(p) - 0.5) - 0.17 : plane(p);
  float unit = 1.0 / v_px;
  float aa = max(fwidth(d), unit * 0.75);
  float outlineWidth = 1.1 * unit;
  float fill = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, d);
  float shape = 1.0 - smoothstep(outlineWidth - aa * 0.5, outlineWidth + aa * 0.5, d);
  vec3 rgb = mix(u_outline, v_color.rgb, fill);
  vec4 color = vec4(rgb, 1.0) * shape;
  if (selected > 0.5) {
    float halo = abs(length(p) - 0.93) - 0.06;
    float cover = 1.0 - smoothstep(-aa * 0.5, aa * 0.5, halo);
    // Under the glyph (premultiplied "over").
    color = color + vec4(u_selection, 1.0) * cover * (1.0 - color.a);
  }
  if (color.a <= 0.003) discard;
  outColor = color;
}`;

const TRAIL_VERTEX = `#version 300 es
layout(location = 0) in vec2 a_a;
layout(location = 1) in vec2 a_b;
layout(location = 2) in float a_side;
layout(location = 3) in float a_end;
layout(location = 4) in float a_t;
layout(location = 5) in vec4 a_color;
uniform mat4 u_matrix;
uniform vec2 u_viewport;
uniform float u_halfWidth;
uniform float u_now;
uniform float u_window;
out vec4 v_color;
out float v_across;
void main() {
  vec4 pa = u_matrix * vec4(a_a, 0.0, 1.0);
  vec4 pb = u_matrix * vec4(a_b, 0.0, 1.0);
  vec2 sa = pa.xy / pa.w * u_viewport * 0.5;
  vec2 sb = pb.xy / pb.w * u_viewport * 0.5;
  vec2 dir = sb - sa;
  float len = length(dir);
  dir = len > 1e-4 ? dir / len : vec2(1.0, 0.0);
  vec2 n = vec2(-dir.y, dir.x);
  vec4 p = a_end < 0.5 ? pa : pb;
  float extent = u_halfWidth + 1.0;
  p.xy += n * a_side * extent * 2.0 / u_viewport * p.w;
  gl_Position = p;
  float age = u_now - a_t;
  float alpha = clamp(1.0 - age / u_window, 0.0, 1.0) * a_color.a;
  v_color = vec4(a_color.rgb * alpha, alpha);
  v_across = a_side * extent;
}`;

const TRAIL_FRAGMENT = `#version 300 es
precision highp float;
in vec4 v_color;
in float v_across;
uniform float u_halfWidth;
out vec4 outColor;
void main() {
  float cover = clamp(u_halfWidth + 0.5 - abs(v_across), 0.0, 1.0);
  if (cover * v_color.a <= 0.003) discard;
  outColor = v_color * cover;
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL: createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`WebGL shader: ${gl.getShaderInfoLog(shader) ?? 'compile failed'}`);
  return shader;
}

function link(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL program: ${gl.getProgramInfoLog(program) ?? 'link failed'}`);
  return program;
}

/** A VAO over one interleaved vertex buffer and one index buffer, with the 32-byte layout of scene.ts. */
interface Mesh {
  readonly vao: WebGLVertexArrayObject;
  readonly vertices: WebGLBuffer;
  readonly indices: WebGLBuffer;
  vertexBytes: number;
  indexCount: number;
}

function createMesh(gl: WebGL2RenderingContext): Mesh {
  const vao = gl.createVertexArray();
  const vertices = gl.createBuffer();
  const indices = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, vertices);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indices);
  const floatAttr = (location: number, size: number, offset: number) => {
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, size, gl.FLOAT, false, VERTEX_BYTES, offset);
  };
  // Both layouts share the float offsets: vec2, vec2, float, float, float, then RGBA8 at byte 28.
  floatAttr(0, 2, 0);
  floatAttr(1, 2, 8);
  floatAttr(2, 1, 16);
  floatAttr(3, 1, 20);
  floatAttr(4, 1, 24);
  gl.enableVertexAttribArray(5);
  gl.vertexAttribPointer(5, 4, gl.UNSIGNED_BYTE, true, VERTEX_BYTES, 28);
  gl.bindVertexArray(null);
  return { vao, vertices, indices, vertexBytes: 0, indexCount: 0 };
}

/** Upload `data` (its used part) into `mesh`, growing the GL buffers when needed. */
function upload(gl: WebGL2RenderingContext, mesh: Mesh, data: VertexData): void {
  const vertexBytes = data.quads * 4 * VERTEX_BYTES;
  const indexCount = data.quads * 6;
  // The element buffer binding is VAO state: bind ours first, never touch MapLibre's.
  gl.bindVertexArray(mesh.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.vertices);
  if (vertexBytes > mesh.vertexBytes) {
    gl.bufferData(gl.ARRAY_BUFFER, data.vertices.byteLength, gl.DYNAMIC_DRAW);
    mesh.vertexBytes = data.vertices.byteLength;
  }
  if (vertexBytes > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.bytes, 0, vertexBytes);
  if (indexCount > mesh.indexCount) {
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    mesh.indexCount = data.indices.length;
  }
}

interface Resources {
  readonly gl: WebGL2RenderingContext;
  readonly glyphProgram: WebGLProgram;
  readonly trailProgram: WebGLProgram;
  readonly glyphs: Mesh;
  readonly trails: Mesh;
  readonly connectors: Mesh;
  readonly track: Mesh;
  readonly u: Record<string, WebGLUniformLocation | null>;
  trailVersion: number;
  trackVersion: number;
}

export interface AircraftLayerOptions {
  /** CSS px half width of trail lines. */
  readonly trailHalfWidth?: number;
  /** CSS px half width of the selected aircraft's track (default 1.75: 3.5 px, against the trails' 2). */
  readonly trackHalfWidth?: number;
  /** Called once when the layer cannot draw (no WebGL2, a shader that does not compile). */
  readonly onError?: (error: Error) => void;
}

export class AircraftLayer implements CustomLayerInterface {
  readonly id = 'gg-aircraft';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;
  private map: MapLibreMap | null = null;
  private res: Resources | null = null;
  private failed = false;
  private readonly matrix = new Float32Array(16);
  private readonly scene: AircraftScene;
  private readonly options: AircraftLayerOptions;

  constructor(scene: AircraftScene, options: AircraftLayerOptions = {}) {
    this.scene = scene;
    this.options = options;
  }

  onAdd(map: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext): void {
    this.map = map;
    this.setup(gl);
  }

  onRemove(): void {
    this.dispose();
    this.map = null;
  }

  /** The context was lost (MapLibre fires `webglcontextlost`): everything is recreated on the next render. */
  contextLost(): void {
    this.res = null;
  }

  private setup(gl: WebGLRenderingContext | WebGL2RenderingContext): Resources | null {
    if (this.failed) return null;
    if (this.res && this.res.gl === gl) return this.res;
    try {
      if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) throw new Error('The aircraft layer needs WebGL2.');
      const glyphProgram = link(gl, GLYPH_VERTEX, GLYPH_FRAGMENT);
      const trailProgram = link(gl, TRAIL_VERTEX, TRAIL_FRAGMENT);
      const u: Record<string, WebGLUniformLocation | null> = {
        gMatrix: gl.getUniformLocation(glyphProgram, 'u_matrix'),
        gViewport: gl.getUniformLocation(glyphProgram, 'u_viewport'),
        gPixelRatio: gl.getUniformLocation(glyphProgram, 'u_pixelRatio'),
        gOutline: gl.getUniformLocation(glyphProgram, 'u_outline'),
        gSelection: gl.getUniformLocation(glyphProgram, 'u_selection'),
        tMatrix: gl.getUniformLocation(trailProgram, 'u_matrix'),
        tViewport: gl.getUniformLocation(trailProgram, 'u_viewport'),
        tHalfWidth: gl.getUniformLocation(trailProgram, 'u_halfWidth'),
        tNow: gl.getUniformLocation(trailProgram, 'u_now'),
        tWindow: gl.getUniformLocation(trailProgram, 'u_window'),
      };
      this.res = { gl, glyphProgram, trailProgram, glyphs: createMesh(gl), trails: createMesh(gl), connectors: createMesh(gl), track: createMesh(gl), u, trailVersion: -1, trackVersion: -1 };
      return this.res;
    } catch (error) {
      this.failed = true;
      this.res = null;
      const err = error instanceof Error ? error : new Error(String(error));
      console.warn('[glassgrid] map: the aircraft layer cannot draw.', err);
      this.options.onError?.(err);
      return null;
    }
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    const start = performance.now();
    const res = this.setup(gl);
    const map = this.map;
    if (!res || !map) return;
    const g = res.gl;
    const now = performance.now();
    // The main matrix takes Mercator 0..1 world coordinates to clip space (mercator projection).
    relativeMatrix(options.defaultProjectionData.mainMatrix, ORIGIN_X, ORIGIN_Y, this.matrix);
    const pixelRatio = map.getPixelRatio();
    const viewport = [g.drawingBufferWidth, g.drawingBufferHeight] as const;
    const scene = this.scene;
    const palette = { outline: scene.outline, selection: scene.selection };

    // Trails (static buffer, re-uploaded when the scene rebuilt it) and connectors (every frame).
    const trails = scene.trails();
    if (res.trailVersion !== scene.trailVersion) {
      upload(g, res.trails, trails);
      res.trailVersion = scene.trailVersion;
    }
    const connectors = scene.connectors(now);
    upload(g, res.connectors, connectors);
    g.useProgram(res.trailProgram);
    g.uniformMatrix4fv(res.u['tMatrix'] ?? null, false, this.matrix);
    g.uniform2f(res.u['tViewport'] ?? null, viewport[0], viewport[1]);
    g.uniform1f(res.u['tHalfWidth'] ?? null, (this.options.trailHalfWidth ?? 1) * pixelRatio);
    g.uniform1f(res.u['tNow'] ?? null, scene.trailTimeAt(now));
    g.uniform1f(res.u['tWindow'] ?? null, 300);
    if (trails.quads > 0) {
      g.bindVertexArray(res.trails.vao);
      g.drawElements(g.TRIANGLES, trails.quads * 6, g.UNSIGNED_INT, 0);
    }
    if (connectors.quads > 0) {
      g.bindVertexArray(res.connectors.vao);
      g.drawElements(g.TRIANGLES, connectors.quads * 6, g.UNSIGNED_INT, 0);
    }
    // The selected track: same program, wider, its times at u_now = 0 so it never fades.
    const track = scene.track();
    if (res.trackVersion !== scene.trackVersion) {
      upload(g, res.track, track);
      res.trackVersion = scene.trackVersion;
    }
    if (track.quads > 0) {
      g.uniform1f(res.u['tHalfWidth'] ?? null, (this.options.trackHalfWidth ?? 1.75) * pixelRatio);
      g.uniform1f(res.u['tNow'] ?? null, 0);
      g.bindVertexArray(res.track.vao);
      g.drawElements(g.TRIANGLES, track.quads * 6, g.UNSIGNED_INT, 0);
    }

    // Glyphs.
    const glyphs = scene.glyphs(now, map.getBearing());
    upload(g, res.glyphs, glyphs);
    if (glyphs.quads > 0) {
      g.useProgram(res.glyphProgram);
      g.uniformMatrix4fv(res.u['gMatrix'] ?? null, false, this.matrix);
      g.uniform2f(res.u['gViewport'] ?? null, viewport[0], viewport[1]);
      g.uniform1f(res.u['gPixelRatio'] ?? null, pixelRatio);
      g.uniform3f(res.u['gOutline'] ?? null, palette.outline[0] / 255, palette.outline[1] / 255, palette.outline[2] / 255);
      g.uniform3f(res.u['gSelection'] ?? null, palette.selection[0] / 255, palette.selection[1] / 255, palette.selection[2] / 255);
      g.bindVertexArray(res.glyphs.vao);
      g.drawElements(g.TRIANGLES, glyphs.quads * 6, g.UNSIGNED_INT, 0);
    }
    g.bindVertexArray(null);
    recordLayerFrame(performance.now() - start, glyphs.quads, trails.quads + connectors.quads + track.quads);
  }

  private dispose(): void {
    const res = this.res;
    this.res = null;
    if (!res || res.gl.isContextLost()) return;
    const g = res.gl;
    for (const mesh of [res.glyphs, res.trails, res.connectors, res.track]) {
      g.deleteVertexArray(mesh.vao);
      g.deleteBuffer(mesh.vertices);
      g.deleteBuffer(mesh.indices);
    }
    g.deleteProgram(res.glyphProgram);
    g.deleteProgram(res.trailProgram);
  }
}

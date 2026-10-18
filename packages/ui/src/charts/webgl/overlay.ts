/*
 * One WebGL canvas for a whole charts panel. Browsers cap live WebGL
 * contexts at roughly 8–16 per page and drop the oldest beyond that, so
 * chart cards never own a context: each dense scatter registers a client
 * with the panel's overlay, and every frame the overlay sets the viewport
 * and scissor rectangle to that client's plot area and lets it draw.
 *
 * Framework-free and injectable (context factory, frame scheduler, DPR) so
 * the allocation and context-loss logic is unit-tested with a fake GL.
 */

export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A client's area in GL coordinates (device px, origin bottom-left) and its visible part. */
export interface GLViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The part of the viewport inside the canvas (and the panel's clip): the scissor box. */
  readonly scissor: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/**
 * The viewport for a client at `client` (client CSS px) on an overlay
 * canvas at `overlay` (client CSS px) with a `canvasWidth`×`canvasHeight`
 * device-pixel backing store; null when nothing of it is visible.
 * `clip` (client CSS px, default the overlay) limits what may be drawn,
 * e.g. the scrolled panel's visible area.
 */
export function computeViewport(overlay: RectLike, client: RectLike, dpr: number, canvasWidth: number, canvasHeight: number, clip: RectLike = overlay): GLViewport | null {
  if (client.width <= 0 || client.height <= 0) return null;
  const left = Math.round((client.left - overlay.left) * dpr);
  const right = Math.round((client.left + client.width - overlay.left) * dpr);
  const top = Math.round((client.top - overlay.top) * dpr);
  const bottom = Math.round((client.top + client.height - overlay.top) * dpr);
  const x = left;
  const y = canvasHeight - bottom;
  const width = right - left;
  const height = bottom - top;
  // Visible part: viewport ∩ canvas ∩ clip.
  const clipLeft = Math.max(0, Math.round((clip.left - overlay.left) * dpr));
  const clipRight = Math.min(canvasWidth, Math.round((clip.left + clip.width - overlay.left) * dpr));
  const clipTop = Math.max(0, Math.round((clip.top - overlay.top) * dpr));
  const clipBottom = Math.min(canvasHeight, Math.round((clip.top + clip.height - overlay.top) * dpr));
  const sl = Math.max(left, clipLeft);
  const sr = Math.min(right, clipRight);
  const st = Math.max(top, clipTop);
  const sb = Math.min(bottom, clipBottom);
  if (sr <= sl || sb <= st) return null;
  return { x, y, width, height, scissor: { x: sl, y: canvasHeight - sb, width: sr - sl, height: sb - st } };
}

/** A dense mark drawn on the shared overlay. */
export interface OverlayClient {
  /** The plot area in client CSS px (`getBoundingClientRect` space), or null while hidden. */
  rect(): RectLike | null;
  /** Draw into the current viewport (viewport, scissor and blending are set). */
  draw(gl: WebGL2RenderingContext, viewport: GLViewport): void;
  /** WebGL became (un)available: draw with Canvas 2D while it is not. */
  availability?(available: boolean): void;
  /** GPU resources of the old context are gone; recreate them on the next draw. */
  contextLost?(): void;
}

export interface OverlayEnvironment {
  getContext(canvas: HTMLCanvasElement): WebGL2RenderingContext | null;
  requestFrame(callback: () => void): number;
  cancelFrame(handle: number): void;
  devicePixelRatio(): number;
}

export const browserEnvironment: OverlayEnvironment = {
  getContext: (canvas) => {
    try {
      return canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    } catch {
      return null;
    }
  },
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  devicePixelRatio: () => window.devicePixelRatio || 1,
};

export interface FrameStats {
  /** Clients drawn in the last frame (visible ones). */
  readonly drawn: number;
  /** Milliseconds the last frame's draw calls took on the CPU side. */
  readonly ms: number;
}

/**
 * The shared overlay. `attach` it to the panel's canvas; clients `register`
 * and call `invalidate` when their data or uniforms change. Scrolling and
 * resizing call `invalidate` too (the provider wires those events).
 */
export class WebGLOverlayManager {
  private canvas: HTMLCanvasElement | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private lost = false;
  /** A client failed to draw (e.g. a shader did not compile): treat WebGL as unavailable. */
  private failed = false;
  private readonly clients = new Set<OverlayClient>();
  private frame: number | null = null;
  private readonly resources = new Map<string, unknown>();
  private clipRect: (() => RectLike | null) | null = null;
  lastFrame: FrameStats = { drawn: 0, ms: 0 };
  private readonly env: OverlayEnvironment;

  constructor(env: OverlayEnvironment = browserEnvironment) {
    this.env = env;
  }

  private readonly onLost = (event: Event) => {
    // preventDefault lets the browser restore the context later.
    event.preventDefault();
    this.handleContextLost();
  };

  private readonly onRestored = () => {
    this.handleContextRestored();
  };

  /** True while a WebGL2 context is live. */
  get available(): boolean {
    return this.gl !== null && !this.lost && !this.failed;
  }

  get context(): WebGL2RenderingContext | null {
    return this.available ? this.gl : null;
  }

  attach(canvas: HTMLCanvasElement, clip?: () => RectLike | null): void {
    if (this.canvas === canvas) return;
    this.detach();
    this.canvas = canvas;
    this.clipRect = clip ?? null;
    this.gl = this.env.getContext(canvas);
    this.lost = false;
    this.failed = false;
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.notify();
    this.invalidate();
  }

  detach(): void {
    if (this.frame !== null) this.env.cancelFrame(this.frame);
    this.frame = null;
    if (this.canvas) {
      this.canvas.removeEventListener('webglcontextlost', this.onLost);
      this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    }
    this.canvas = null;
    this.gl = null;
    this.resources.clear();
    this.notify();
  }

  register(client: OverlayClient): () => void {
    this.clients.add(client);
    client.availability?.(this.available);
    this.invalidate();
    return () => {
      this.clients.delete(client);
      this.invalidate();
    };
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** A per-context resource (e.g. a compiled program), created once and dropped on context loss. */
  resource<T>(key: string, create: (gl: WebGL2RenderingContext) => T): T | null {
    const gl = this.context;
    if (!gl) return null;
    if (!this.resources.has(key)) this.resources.set(key, create(gl));
    return this.resources.get(key) as T;
  }

  /** Schedule a redraw on the next animation frame (coalesced). */
  invalidate(): void {
    if (this.frame !== null || !this.canvas) return;
    this.frame = this.env.requestFrame(() => {
      this.frame = null;
      this.render();
    });
  }

  /** Draw every visible client now. */
  render(): void {
    const canvas = this.canvas;
    const gl = this.context;
    if (!canvas || !gl) return;
    const start = performance.now();
    const dpr = this.env.devicePixelRatio();
    const overlay = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(overlay.width * dpr));
    const h = Math.max(1, Math.round(overlay.height * dpr));
    if (canvas.width !== w) canvas.width = w;
    if (canvas.height !== h) canvas.height = h;
    gl.disable(gl.SCISSOR_TEST);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const clip = this.clipRect?.() ?? overlay;
    let drawn = 0;
    for (const client of this.clients) {
      const rect = client.rect();
      if (!rect) continue;
      const viewport = computeViewport(overlay, rect, dpr, w, h, clip);
      if (!viewport) continue;
      gl.viewport(viewport.x, viewport.y, viewport.width, viewport.height);
      gl.scissor(viewport.scissor.x, viewport.scissor.y, viewport.scissor.width, viewport.scissor.height);
      try {
        client.draw(gl, viewport);
      } catch (error) {
        console.warn('WebGL overlay: drawing failed, falling back to Canvas 2D.', error);
        this.failed = true;
        this.resources.clear();
        this.notify();
        break;
      }
      drawn += 1;
    }
    gl.disable(gl.SCISSOR_TEST);
    this.lastFrame = { drawn, ms: performance.now() - start };
  }

  /** Context lost (GPU reset, too many contexts): clients fall back to Canvas 2D. */
  handleContextLost(): void {
    this.lost = true;
    this.resources.clear();
    for (const client of this.clients) client.contextLost?.();
    this.notify();
  }

  handleContextRestored(): void {
    if (!this.canvas) return;
    this.gl = this.env.getContext(this.canvas) ?? this.gl;
    this.lost = this.gl === null || this.gl.isContextLost();
    this.notify();
    this.invalidate();
  }

  private notify(): void {
    const available = this.available;
    for (const client of this.clients) client.availability?.(available);
  }
}

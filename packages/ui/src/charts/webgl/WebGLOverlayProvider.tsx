import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { WebGLOverlayManager, type OverlayEnvironment, type ScatterStrategy } from './overlay.js';

const OverlayContext = createContext<WebGLOverlayManager | null>(null);

/** The panel's shared overlay, or null outside a `WebGLOverlayProvider` (scatter then draws with Canvas 2D). */
export function useWebGLOverlay(): WebGLOverlayManager | null {
  return useContext(OverlayContext);
}

export interface WebGLOverlayProviderProps {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Test seam: context factory, frame scheduler and DPR. */
  environment?: OverlayEnvironment;
  /**
   * How dense scatters draw: `auto` (default) uses instanced quads on GPUs and
   * plain points on software renderers (SwiftShader), where instancing is slow.
   */
  scatterStrategy?: 'auto' | ScatterStrategy;
  /** Receives the manager (benchmarks read `lastFrame`). */
  onManager?: (manager: WebGLOverlayManager) => void;
  testId?: string;
}

/**
 * Wraps a charts panel (put it around the panel's scroll viewport) and owns
 * the one WebGL canvas every dense scatter inside draws on. The canvas
 * covers the wrapper, ignores the pointer and sits between the charts'
 * own canvases (z-index 1) and their brush overlays (z-index 2).
 */
export function WebGLOverlayProvider({ children, className, style, environment, scatterStrategy = 'auto', onManager, testId }: WebGLOverlayProviderProps) {
  const [manager] = useState(() => new WebGLOverlayManager(environment));
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const root = rootRef.current;
    if (!canvas || !root) return;
    manager.attach(canvas, () => root.getBoundingClientRect());
    onManager?.(manager);
    const invalidate = () => manager.invalidate();
    // Scroll does not bubble; capture sees scrolling anywhere inside the panel.
    root.addEventListener('scroll', invalidate, true);
    window.addEventListener('resize', invalidate);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(invalidate);
    observer?.observe(root);
    return () => {
      root.removeEventListener('scroll', invalidate, true);
      window.removeEventListener('resize', invalidate);
      observer?.disconnect();
      manager.detach();
    };
  }, [manager, onManager]);

  useEffect(() => {
    manager.setScatterStrategy(scatterStrategy);
  }, [manager, scatterStrategy]);

  useEffect(() => () => manager.detach(), [manager]);

  return (
    <OverlayContext.Provider value={manager}>
      <div ref={rootRef} className={className ? `gg-webgl-overlay-root ${className}` : 'gg-webgl-overlay-root'} style={style} data-testid={testId}>
        {children}
        <canvas ref={canvasRef} className="gg-webgl-overlay" aria-hidden="true" />
      </div>
    </OverlayContext.Provider>
  );
}

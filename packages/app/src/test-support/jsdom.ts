import { vi } from 'vitest';

/** A 2D context that draws nothing: jsdom has no canvas backend. */
function nullContext(): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get: (target, key) => {
      if (key in target) return target[key];
      if (key === 'measureText') return (text: string) => ({ width: text.length * 7 });
      return () => undefined;
    },
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** jsdom has no canvas and no layout: canvases draw nothing, the grid's scroller and chart plots get sizes. Call in `beforeEach`. */
export function stubLayout(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => nullContext());
  // jsdom does no layout: give the grid's scroller a viewport.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    // ...and the chart plots a width, so brushable charts build their models.
    return this.classList.contains('gg-cgrid__scroller') ? 800 : this.classList.contains('gg-chart__plot') ? 300 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('gg-cgrid__scroller') ? 400 : 0;
  });
  window.matchMedia = vi.fn((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

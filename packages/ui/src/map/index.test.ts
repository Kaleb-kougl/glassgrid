/// <reference types="vite/client" />
import { describe, expect, it, vi } from 'vitest';

vi.mock('./MapView.js', () => ({
  MapView: function FakeMapView() {
    return null;
  },
}));

const { loadMapView } = await import('./index');
/** The module sources, as text (Vite's ?raw). */
const sources = import.meta.glob<string>(['./*.ts', './*.tsx', '!./*.test.ts'], { query: '?raw', import: 'default', eager: true });

/** Static imports and re-exports of a module (not `import type`, not `import()`). */
function staticImports(file: string): string[] {
  const source = sources[file] ?? '';
  return [...source.matchAll(/^(?:import|export)\s+(?!type\s)(?:[^'";]*?from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? '');
}

describe('@glassgrid/ui/map entry', () => {
  it('never imports MapLibre or the map component statically: they come with loadMapView()', () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      for (const spec of staticImports(file)) {
        expect(spec, `${file} imports ${spec}`).not.toMatch(/maplibre|MapView|aircraft-layer|scene|\.css$/);
        if (!spec.startsWith('./')) continue;
        const ts = spec.replace(/\.js$/, '.ts');
        visit(ts in sources ? ts : spec.replace(/\.js$/, '.tsx'));
      }
    };
    visit('./index.ts');
    expect([...seen].sort()).toEqual(['./AltitudeLegend.tsx', './altitude.ts', './index.ts', './stats.ts']);
    expect(sources['./index.ts']).toContain("import('./MapView.js')");
  });

  it('loadMapView resolves the component once and reuses it', async () => {
    const first = loadMapView();
    expect(loadMapView()).toBe(first);
    const component = await first;
    expect(component.name).toBe('FakeMapView');
  });
});

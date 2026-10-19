import { describe, expect, it, vi } from 'vitest';
import { ChartSpecSchema, parseWorkspace, toFileHandle, type Fingerprint } from '@glassgrid/core';
import { createAppWorkspace } from '@glassgrid/app';
import manifest from '../public/samples/samples.manifest.json';
import { openSampleWorkspace, sampleFromSearch, SAMPLES, SAMPLES_PATH, type SampleOpenDeps } from './samples';

/*
 * The committed sample workspaces (public/samples/*.glassgrid, written by
 * tools/datasets/src/samples.ts) are valid format-v1 workspaces for core's
 * reader, match the start screen's catalog and the data they describe, and
 * open through `loadWorkspace` with the data relinked by URL.
 */

const workspaces = import.meta.glob<string>('../public/samples/*.glassgrid', { query: '?raw', import: 'default', eager: true });
const byName = new Map(Object.entries(workspaces).map(([path, text]) => [path.split('/').pop() ?? path, text]));

const FINGERPRINT: Fingerprint = { sizeBytes: 1, mtimeMs: 0, headTailSha256: 'a'.repeat(64), key: 'b'.repeat(32) };
const HANDLE = toFileHandle('7f0c3a52-1d47-4f8e-9a51-0c8f3e3b6a10');

describe('sample workspaces', () => {
  it('there is one per manifest entry, and each parses as a current-format workspace without warnings', () => {
    expect([...byName.keys()].sort()).toEqual(manifest.samples.map((sample) => sample.workspace).sort());
    for (const sample of manifest.samples) {
      const parsed = parseWorkspace(byName.get(sample.workspace));
      expect(parsed.migratedFrom).toBeNull();
      expect(parsed.warnings).toEqual([]);
      expect(parsed.file.formatVersion).toBe(1);
      expect(parsed.data.fileName).toBe(sample.file);
      expect(parsed.data.fingerprint.sizeBytes).toBe(sample.bytes);
      // The columns are the data's, in order; every chart reads only those; 3–4 charts, each with a card.
      expect(parsed.workspace.columns.map((column) => column.name)).toEqual(sample.columns.map((column) => column.name));
      const names = new Set(parsed.workspace.columns.map((column) => column.name));
      expect(parsed.workspace.charts.length).toBeGreaterThanOrEqual(3);
      expect(parsed.workspace.charts.length).toBeLessThanOrEqual(4);
      for (const chart of parsed.workspace.charts) {
        const spec = ChartSpecSchema.parse(chart.spec);
        for (const field of [spec.x, spec.y, spec.color]) if (field) expect(names).toContain(field.column);
        expect(chart.title).toBeTruthy();
      }
      expect(parsed.workspace.layout.cards.map((card) => card.chartId)).toEqual(parsed.workspace.charts.map((chart) => chart.id));
    }
  });

  it('the start screen offers exactly the generated samples, with their real sizes', () => {
    expect(SAMPLES.map(({ id, workspace, data }) => ({ id, workspace, data }))).toEqual(
      manifest.samples.map(({ id, workspace, file }) => ({ id, workspace, data: file })),
    );
    for (const sample of SAMPLES) {
      const entry = manifest.samples.find((candidate) => candidate.id === sample.id);
      if (!entry) throw new Error(`no manifest entry for ${sample.id}`);
      const rows = entry.rows >= 1e6 ? `${Number((entry.rows / 1e6).toFixed(1))}M rows` : `${Math.round(entry.rows / 1e3)}k rows`;
      expect(sample.detail).toBe(`${rows} · ${Math.round(entry.bytes / 1e6)} MB Parquet`);
    }
    // Together they stay a reasonable download (each ≤ 25 MB).
    for (const entry of manifest.samples) expect(entry.bytes).toBeLessThanOrEqual(25e6);
  });

  it('reads the sample a link names', () => {
    expect(sampleFromSearch('?sample=retail')?.id).toBe('retail');
    expect(sampleFromSearch('?sample=nope')).toBeNull();
    expect(sampleFromSearch('')).toBeNull();
  });
});

function deps(overrides: Partial<SampleOpenDeps> = {}) {
  const taxi = byName.get('taxi.glassgrid') ?? '';
  const columns = parseWorkspace(taxi).workspace.columns.map((column) => ({ name: column.name, type: column.inferredType }));
  const workspace = createAppWorkspace();
  const registerUrl = vi.fn((_url: string, options?: { name?: string }) => Promise.resolve({ handle: HANDLE, fileName: options?.name ?? 'data' }));
  const open = vi.fn((handle: string) => Promise.resolve({ table: { id: `t_${handle}`, fingerprint: FINGERPRINT, columns } }));
  const fetch = vi.fn((_url: string) => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(taxi) }));
  const onWarnings = vi.fn();
  const all = { engine: { open } as unknown as SampleOpenDeps['engine'], registerUrl, registry: workspace.registry, fetch, onWarnings, ...overrides };
  return { all, workspace, registerUrl, open, fetch, onWarnings, columns };
}

describe('openSampleWorkspace', () => {
  const taxi = SAMPLES.find((sample) => sample.id === 'taxi');
  if (!taxi) throw new Error('no taxi sample');

  it('fetches the workspace, relinks its data by URL, and loads it as one undoable entry', async () => {
    const { all, workspace, registerUrl, open, fetch, onWarnings } = deps();
    expect(await openSampleWorkspace(taxi, all)).toEqual({ status: 'cancelled' });
    expect(fetch).toHaveBeenCalledWith('/samples/taxi.glassgrid');
    expect(registerUrl).toHaveBeenCalledWith('/samples/taxi-trips-2025h1.parquet', { name: 'taxi-trips-2025h1.parquet' });
    expect(open).toHaveBeenCalledWith(HANDLE);
    expect(onWarnings).not.toHaveBeenCalled();
    const state = workspace.store.getState();
    expect(state.dataSource).toMatchObject({ handleId: HANDLE, fileName: 'taxi-trips-2025h1.parquet' });
    expect(state.charts.map((chart) => chart.title)).toEqual(['Trips per day', 'Trips by pickup zone', 'Trip distance (km)', 'Pickup locations']);
    expect(state.document).toMatchObject({ id: null, fileName: 'taxi.glassgrid' });
    expect(workspace.store.getHistory().past).toHaveLength(1);
  });

  it('reads everything from the samples base, never from the workspace\'s absolutePath (a subfolder build: /glassgrid/samples/)', async () => {
    const { all, fetch, registerUrl } = deps({ base: '/glassgrid/samples/' });
    // The committed workspaces record "/samples/<file>" as absolutePath (metadata from the generator); the web loader ignores it.
    expect(parseWorkspace(byName.get('taxi.glassgrid')).data.absolutePath).toBe('/samples/taxi-trips-2025h1.parquet');
    expect(await openSampleWorkspace(taxi, all)).toEqual({ status: 'cancelled' });
    expect(fetch).toHaveBeenCalledWith('/glassgrid/samples/taxi.glassgrid');
    expect(registerUrl).toHaveBeenCalledWith('/glassgrid/samples/taxi-trips-2025h1.parquet', { name: 'taxi-trips-2025h1.parquet' });
    expect(SAMPLES_PATH).toBe('/samples/'); // the default build's base is /
  });

  it('reports restore warnings when the data no longer matches the workspace', async () => {
    const { all, onWarnings, columns } = deps();
    const fewer = columns.filter((column) => column.name !== 'pickup_zone');
    all.engine = { open: () => Promise.resolve({ table: { id: 't', fingerprint: FINGERPRINT, columns: fewer } }) } as unknown as SampleOpenDeps['engine'];
    expect(await openSampleWorkspace(taxi, all)).toEqual({ status: 'cancelled' });
    expect(onWarnings).toHaveBeenCalledOnce();
    expect(JSON.stringify(onWarnings.mock.calls[0]?.[1])).toContain('pickup_zone');
  });

  it('fails with a message when the workspace is missing or broken', async () => {
    const missing = deps({ fetch: () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') }) });
    expect(await openSampleWorkspace(taxi, missing.all)).toEqual({ status: 'failed', message: 'The Taxi trips sample is not available (HTTP 404)' });
    const broken = deps({ fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"formatVersion": 1') }) });
    const result = await openSampleWorkspace(taxi, broken.all);
    expect(result).toMatchObject({ status: 'failed', message: expect.stringContaining('is not a valid workspace') as string });
    expect(broken.registerUrl).not.toHaveBeenCalled();
  });
});

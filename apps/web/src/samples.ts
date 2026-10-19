import {
  parseWorkspace,
  restoreWorkspace,
  type CommandRegistry,
  type FileHandle,
  type OpenCsvResult,
  type OpenedData,
} from '@glassgrid/core';
import type { EngineClientLike, SampleDataset } from '@glassgrid/app';
import { withBase } from './base';

/*
 * The web demo's sample workspaces. Each sample is a `.glassgrid` (format v1)
 * workspace with a few cross-filtered charts, over a synthetic Parquet file
 * served from this origin under <base>samples/ (generated and committed by
 * `pnpm --filter @glassgrid/datasets samples`; see tools/datasets/src/samples.ts).
 *
 * Opening one is a workspace open with the data relinked by URL: fetch the
 * workspace file, parse it with core's reader (migrations, validation),
 * register the Parquet URL with the engine, open it, and replace the
 * workspace with core's `loadWorkspace` command, the same state change a
 * desktop .glassgrid open ends with (one undo entry, clean afterwards).
 */

export interface SampleInfo extends SampleDataset {
  /** The workspace file, relative to the samples folder. */
  readonly workspace: string;
  /** The data file the workspace's charts read, relative to the samples folder. */
  readonly data: string;
}

/** Served from public/samples/ (checked against samples.manifest.json by samples.test.ts). */
export const SAMPLES: readonly SampleInfo[] = [
  { id: 'taxi', label: 'Taxi trips', detail: '2M rows · 21 MB Parquet', workspace: 'taxi.glassgrid', data: 'taxi-trips-2025h1.parquet' },
  { id: 'retail', label: 'Retail orders', detail: '1.5M rows · 11 MB Parquet', workspace: 'retail.glassgrid', data: 'retail-orders-2023-2025.parquet' },
  { id: 'sensors', label: 'Sensor readings', detail: '1.4M rows · 8 MB Parquet', workspace: 'sensors.glassgrid', data: 'sensor-readings-2025-09.parquet' },
];

/** Where the samples are served: `/samples/`, or `/glassgrid/samples/` in a subfolder build. */
export const SAMPLES_PATH = withBase('samples/');

/** The sample a link asks for (`/?sample=taxi`), or null. */
export function sampleFromSearch(search: string, samples: readonly SampleInfo[] = SAMPLES): SampleInfo | null {
  const id = new URLSearchParams(search).get('sample');
  return id === null ? null : (samples.find((sample) => sample.id === id) ?? null);
}

export interface SampleOpenDeps {
  readonly engine: Pick<EngineClientLike, 'open'>;
  /** The engine's URL source registration (`WorkerEngine.registerUrl`). */
  readonly registerUrl: (url: string, options?: { name?: string }) => Promise<{ handle: FileHandle; fileName: string }>;
  readonly registry: Pick<CommandRegistry, 'dispatch'>;
  readonly fetch?: (url: string) => Promise<Pick<Response, 'ok' | 'status' | 'text'>>;
  /** Where the samples are served (default SAMPLES_PATH, under the base). */
  readonly base?: string;
  /** Restore warnings (a column the data no longer has, a changed type): none are expected for a sample. */
  readonly onWarnings?: (sample: SampleInfo, warnings: readonly { code: string; message: string }[]) => void;
}

/**
 * Opens a sample workspace. Resolves `cancelled` once the workspace is
 * loaded (the app's file-open path then has nothing left to record), or
 * `failed` with a message for the person.
 */
export async function openSampleWorkspace(sample: SampleInfo, deps: SampleOpenDeps): Promise<OpenCsvResult> {
  const base = deps.base ?? SAMPLES_PATH;
  const load = deps.fetch ?? ((url: string) => fetch(url));
  let text: string;
  try {
    const response = await load(`${base}${sample.workspace}`);
    if (!response.ok) return { status: 'failed', message: `The ${sample.label} sample is not available (HTTP ${response.status})` };
    text = await response.text();
  } catch (error) {
    return { status: 'failed', message: `The ${sample.label} sample could not be loaded: ${messageOf(error)}` };
  }
  let parsed;
  try {
    parsed = parseWorkspace(text);
  } catch (error) {
    return { status: 'failed', message: `The ${sample.label} sample is not a valid workspace: ${messageOf(error)}` };
  }

  const source = await deps.registerUrl(`${base}${sample.data}`, { name: parsed.data.fileName });
  const { table } = await deps.engine.open(source.handle);
  const data: OpenedData = {
    handleId: source.handle,
    fileName: source.fileName,
    fingerprint: table.fingerprint,
    columns: table.columns.map((column) => ({ name: column.name, type: column.type })),
  };
  const document = { id: null, fileName: sample.workspace };
  const { warnings } = restoreWorkspace(parsed.workspace, data, { ...document, savedDigest: null });
  const all = [...parsed.warnings, ...warnings];
  if (all.length > 0) deps.onWarnings?.(sample, all);
  await deps.registry.dispatch('loadWorkspace', { data, workspace: parsed.workspace, document, recovered: false }, { caller: 'user' });
  return { status: 'cancelled' };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

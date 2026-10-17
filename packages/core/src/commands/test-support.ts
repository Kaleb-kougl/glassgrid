// Test helpers for command tests. Not exported from the package.
import type { CommandPolicy } from './registry.js';
import { createWorkspace } from './all.js';
import type { OpenFileInput } from './builtins/open-file.js';

export function fakeClock(start = 1_000, step = 1): () => number {
  let now = start - step;
  return () => (now += step);
}

export function sequentialIds(): (prefix: string) => string {
  let next = 0;
  return (prefix) => `${prefix}_${++next}`;
}

export function testWorkspace(policy?: CommandPolicy): ReturnType<typeof createWorkspace> {
  return createWorkspace({
    clock: fakeClock(),
    newId: sequentialIds(),
    ...(policy === undefined ? {} : { policy }),
  });
}

export function openFileInput(overrides: Partial<OpenFileInput> = {}): OpenFileInput {
  return {
    handleId: 'fh_0123456789abcdef',
    fileName: 'sales.csv',
    fingerprint: { sizeBytes: 31_000_000, mtimeMs: 1_760_000_000_000, sampleHash: 'abc123' },
    columns: [
      { name: 'id', type: 'integer' },
      { name: 'category', type: 'text' },
      { name: 'amount', type: 'float' },
      { name: 'created_on', type: 'date' },
    ],
    ...overrides,
  } as OpenFileInput;
}

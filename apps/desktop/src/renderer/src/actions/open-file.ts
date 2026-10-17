import {
  OpenCsvResultSchema,
  type CommandRegistry,
  type GlassgridBridge,
  type OpenedFile,
  type TableHandle,
} from '@glassgrid/core';
import type { EngineClient } from '../engine-client';

/** What the open action needs; narrow so tests can pass fakes. */
export interface OpenFileDeps {
  readonly bridge: Pick<GlassgridBridge, 'openCsv'>;
  readonly engine: Pick<EngineClient, 'open'>;
  readonly registry: Pick<CommandRegistry, 'dispatch'>;
  /** Called after the engine opened the table, just before `openFile` changes the state. */
  readonly onEngineOpened?: (table: TableHandle, engineMs: number) => void;
}

export type OpenFileOutcome =
  | { readonly status: 'cancelled' }
  | {
      readonly status: 'opened';
      readonly file: OpenedFile;
      readonly table: TableHandle;
      /** Engine time for `open` (fingerprint, view, DESCRIBE). */
      readonly openEngineMs: number;
      /** The undo entry `openFile` recorded. */
      readonly entryId: string | null;
    };

/**
 * The async half of "open a file" (see docs/m1-commands.md, "The async action
 * pattern"): main's native dialog registers the file and returns a handle,
 * the engine opens it (fingerprint and inferred column types), and only then
 * the synchronous `openFile` command records the result. Undo therefore never
 * re-runs engine work.
 *
 * The profile and the first grid page are views of the new state: they are
 * requested once `openFile` has changed the data source, so the column list
 * appears without waiting for a full-table profile scan.
 */
export async function openFileAction(deps: OpenFileDeps): Promise<OpenFileOutcome> {
  const picked = OpenCsvResultSchema.parse(await deps.bridge.openCsv());
  if (picked.status === 'cancelled') return { status: 'cancelled' };
  if (picked.status === 'failed') throw new Error(`Could not open file: ${picked.message}`);

  const { table, engineMs } = await deps.engine.open(picked.file.handle);
  deps.onEngineOpened?.(table, engineMs);
  const { entryId } = await deps.registry.dispatch(
    'openFile',
    {
      handleId: picked.file.handle,
      fileName: picked.file.displayName,
      fingerprint: table.fingerprint,
      columns: table.columns.map((column) => ({ name: column.name, type: column.type })),
    },
    { caller: 'user' },
  );
  return { status: 'opened', file: picked.file, table, openEngineMs: engineMs, entryId };
}

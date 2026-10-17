import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createInitialWorkspaceState, WorkspaceStateSchema } from '../state/workspace.js';
import { defineCommand } from './define.js';
import { CommandError } from './errors.js';
import { CommandRegistry } from './registry.js';
import { WorkspaceStore } from './store.js';
import { fakeClock, openFileInput, sequentialIds, testWorkspace } from './test-support.js';

async function rejection(promise: Promise<unknown>): Promise<CommandError> {
  const error: unknown = await promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(CommandError);
  return error as CommandError;
}

const sortById = (tier: 'write' | 'raw') =>
  defineCommand({
    name: tier === 'write' ? 'testWrite' : 'testRaw',
    description: 'test',
    input: z.strictObject({}),
    tier,
    mcp: true,
    apply(draft) {
      draft.grid.sort = [{ column: 'id', direction: 'asc' }];
    },
  });

describe('input validation', () => {
  it('rejects unknown commands', async () => {
    const { registry } = testWorkspace();
    const error = await rejection(registry.dispatch('dropTable', {}, { caller: 'ai' }));
    expect(error.code).toBe('unknown_command');
    expect(error.message).toContain('dropTable');
  });

  it('rejects unknown callers', async () => {
    const { registry } = testWorkspace();
    const error = await rejection(registry.dispatch('undo', {}, { caller: 'robot' as 'ai' }));
    expect(error.code).toBe('invalid_caller');
  });

  it('reports each bad field with its path', async () => {
    const { registry } = testWorkspace();
    const bad = { ...openFileInput(), handleId: '/etc/passwd', columns: [{ name: 'a', type: 'varchar' }] };
    const error = await rejection(registry.dispatch('openFile', bad, { caller: 'user' }));
    expect(error.code).toBe('invalid_input');
    expect(error.command).toBe('openFile');
    expect(error.issues.map((issue) => issue.path)).toEqual(['handleId', 'columns[0].type']);
    expect(error.message).toMatch(/^Invalid input for "openFile": handleId: Invalid file handle; columns\[0\]\.type: /);
    expect(error.message).toContain('"timestamp"');
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({ code: 'invalid_input', command: 'openFile' });
  });

  it('rejects unknown keys so typos are not silently ignored', async () => {
    const { registry } = testWorkspace();
    await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    const error = await rejection(
      registry.dispatch('setColumnType', { colum: 'id', type: 'text' }, { caller: 'ai' }),
    );
    expect(error.issues.map((issue) => issue.path)).toEqual(['column', '']);
    expect(error.message).toContain('Unrecognized key: "colum"');
  });

  it('rejects duplicate column names', async () => {
    const { registry } = testWorkspace();
    const input = openFileInput({ columns: [{ name: 'a', type: 'text' }, { name: 'a', type: 'integer' }] });
    const error = await rejection(registry.dispatch('openFile', input, { caller: 'user' }));
    expect(error.message).toContain('Column names must be unique');
  });

  it('leaves state and history untouched on failure', async () => {
    const { registry, store } = testWorkspace();
    const before = store.getState();
    const listener = vi.fn();
    store.subscribe(listener);
    await rejection(registry.dispatch('setColumnType', { column: 'nope', type: 'text' }, { caller: 'user' }));
    expect(store.getState()).toBe(before);
    expect(store.getHistory().past).toHaveLength(0);
    expect(listener).not.toHaveBeenCalled();
  });

  it('treats a missing input as an empty object', async () => {
    const { registry } = testWorkspace();
    await expect(registry.dispatch('undo', undefined, { caller: 'user' })).resolves.toMatchObject({ entryId: null });
  });
});

describe('tier policy', () => {
  function registryWith(policy?: ConstructorParameters<typeof CommandRegistry>[1]) {
    const store = new WorkspaceStore(createInitialWorkspaceState(), { clock: fakeClock(), newId: sequentialIds() });
    const registry = new CommandRegistry(store, policy);
    registry.register(sortById('write')).register(sortById('raw'));
    return { store, registry };
  }

  it('refuses write and raw commands when the host supplies no hook', async () => {
    const { registry, store } = registryWith();
    expect((await rejection(registry.dispatch('testWrite', {}, { caller: 'user' }))).code).toBe('forbidden');
    expect((await rejection(registry.dispatch('testRaw', {}, { caller: 'ai' }))).code).toBe('forbidden');
    expect(store.getState().grid.sort).toEqual([]);
  });

  it('asks confirmWrite for write commands and allowRaw for raw commands', async () => {
    const confirmWrite = vi.fn(() => Promise.resolve(true));
    const allowRaw = vi.fn(() => false);
    const { registry, store } = registryWith({ policy: { confirmWrite, allowRaw } });

    const result = await registry.dispatch('testWrite', {}, { caller: 'ai' });
    expect(confirmWrite).toHaveBeenCalledWith({ command: 'testWrite', tier: 'write', caller: 'ai', input: {} });
    expect(result.entryId).not.toBeNull();
    expect(store.getState().grid.sort).toHaveLength(1);

    const error = await rejection(registry.dispatch('testRaw', {}, { caller: 'user' }));
    expect(error.code).toBe('forbidden');
    expect(allowRaw).toHaveBeenCalledWith({ command: 'testRaw', tier: 'raw', caller: 'user', input: {} });
    expect(confirmWrite).toHaveBeenCalledTimes(1);
  });

  it('runs read and edit commands without consulting the policy', async () => {
    const confirmWrite = vi.fn(() => false);
    const { registry } = testWorkspace({ confirmWrite, allowRaw: confirmWrite });
    await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    await registry.dispatch('setColumnType', { column: 'id', type: 'text' }, { caller: 'ai' });
    expect(confirmWrite).not.toHaveBeenCalled();
  });

  it('applies edit commands synchronously, before the promise settles', () => {
    const { registry, store } = testWorkspace();
    void registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    expect(store.getState().dataSource?.fileName).toBe('sales.csv');
  });

  it('refuses MCP-exempt commands from AI callers', async () => {
    const { registry, store } = testWorkspace();
    const error = await rejection(registry.dispatch('openFile', openFileInput(), { caller: 'ai' }));
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('native dialog');
    expect(store.getState().dataSource).toBeNull();
  });

  it('rejects read-tier commands that change state', async () => {
    const { registry, store } = testWorkspace();
    registry.register(
      defineCommand({
        name: 'sneakyRead',
        description: 'test',
        input: z.strictObject({}),
        tier: 'read',
        mcp: true,
        apply(draft) {
          draft.charts.push({ id: 'c1', spec: {} });
        },
      }),
    );
    await expect(registry.dispatch('sneakyRead', {}, { caller: 'ai' })).rejects.toThrow(/Read-tier/);
    expect(store.getState().charts).toEqual([]);
  });
});

describe('registration and listing', () => {
  it('lists every command with tier, MCP exposure and JSON Schema', () => {
    const { registry } = testWorkspace();
    const list = registry.list();
    expect(list.map((info) => info.name)).toEqual(['openFile', 'setColumnType', 'undo', 'redo']);

    const setType = list.find((info) => info.name === 'setColumnType');
    expect(setType).toMatchObject({ tier: 'edit', mcp: { exposed: true } });
    expect(setType?.inputSchema).toMatchObject({
      type: 'object',
      required: ['column', 'type'],
      additionalProperties: false,
      properties: {
        column: { type: 'string' },
        type: { enum: ['integer', 'float', 'decimal', 'boolean', 'date', 'timestamp', 'text'] },
      },
    });

    const open = list.find((info) => info.name === 'openFile');
    expect(open?.mcp).toMatchObject({ exposed: false });
    expect(open?.inputSchema).toMatchObject({ properties: { handleId: { pattern: '^fh_[A-Za-z0-9-]{8,64}$' } } });

    // The listing is sent over MCP as JSON.
    expect(JSON.parse(JSON.stringify(list))).toEqual(list);
  });

  it('refuses duplicates, bad names and missing mcp declarations', () => {
    const { registry } = testWorkspace();
    const base = { description: 'x', input: z.strictObject({}), tier: 'edit' as const, apply: () => undefined };
    expect(() => registry.register(defineCommand({ ...base, name: 'undo', mcp: true }))).toThrow(/already/);
    expect(() => registry.register(defineCommand({ ...base, name: 'drop-table', mcp: true }))).toThrow(/camelCase/);
    expect(() =>
      registry.register(defineCommand({ ...base, name: 'noMcp', mcp: undefined as unknown as true })),
    ).toThrow(/must declare mcp/);
    expect(() => registry.register(defineCommand({ ...base, name: 'blank', mcp: { exempt: '  ' } }))).toThrow(
      /must declare mcp/,
    );
  });
});

describe('attribution, notifications and serialisation', () => {
  it('records the caller on each entry', async () => {
    const { registry, store } = testWorkspace();
    await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    const { entryId } = await registry.dispatch('setColumnType', { column: 'amount', type: 'decimal' }, { caller: 'ai' });

    const past = store.getHistory().past;
    expect(past.map((entry) => [entry.name, entry.caller])).toEqual([
      ['openFile', 'user'],
      ['setColumnType', 'ai'],
    ]);
    expect(past[1]).toMatchObject({
      id: entryId,
      input: { column: 'amount', type: 'decimal' },
      at: 1_001,
    });
  });

  it('notifies subscribers exactly once per state-changing dispatch', async () => {
    const { registry, store } = testWorkspace();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    expect(listener).toHaveBeenCalledTimes(1);
    await registry.dispatch('setColumnType', { column: 'id', type: 'text' }, { caller: 'ai' });
    expect(listener).toHaveBeenCalledTimes(2);
    await registry.dispatch('undo', {}, { caller: 'ai' });
    expect(listener).toHaveBeenCalledTimes(3);
    await registry.dispatch('redo', {}, { caller: 'user' });
    expect(listener).toHaveBeenCalledTimes(4);

    // No-ops change nothing and notify nobody.
    await registry.dispatch('setColumnType', { column: 'id', type: 'text' }, { caller: 'ai' });
    await registry.dispatch('redo', {}, { caller: 'user' });
    expect(listener).toHaveBeenCalledTimes(4);

    unsubscribe();
    await registry.dispatch('undo', {}, { caller: 'user' });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('keeps state and undo entries plain JSON', async () => {
    const { registry, store } = testWorkspace();
    await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    const { state } = await registry.dispatch('setColumnType', { column: 'id', type: 'text' }, { caller: 'ai' });

    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    expect(WorkspaceStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
    const history = store.getHistory();
    expect(JSON.parse(JSON.stringify(history))).toEqual(history);
  });

  it('returns the store snapshot from dispatch', async () => {
    const { registry, store } = testWorkspace();
    const { state } = await registry.dispatch('openFile', openFileInput(), { caller: 'user' });
    expect(state).toBe(store.getState());
    expect(Object.isFrozen(state)).toBe(true);
  });
});

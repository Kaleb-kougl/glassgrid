# M1 notes: command registry, state store and undo

How workspace state changes in Glassgrid. Code lives in
`packages/core/src/state/` and `packages/core/src/commands/`. Dated 2026-10-17.

## The pieces

```
UI event / MCP run_command
        │  registry.dispatch(name, rawInput, { caller: 'user' | 'ai' })
        ▼
CommandRegistry ── Zod parse ── tier policy ── MCP exemption check (ai only)
        │
        ▼
WorkspaceStore.commit ── Immer produceWithPatches ── undo entry ── notify once
        │
        ▼
{ state, entryId }      React: useSyncExternalStore(store.subscribe, store.getState)
```

- **`WorkspaceState`** is plain JSON: data source (handle, display name,
  fingerprint), columns (inferred type plus optional override), charts
  (`{ id, spec }`), filters by view id, grid sort and card layout.
  `WorkspaceStateSchema` validates it, so the same schema can load a
  `.glassgrid` file in M4.
- **`WorkspaceStore`** holds the frozen state and the history. `getState`,
  `getHistory` and `subscribe` are bound and return stable references between
  changes, so they plug straight into `useSyncExternalStore`.
- **`CommandRegistry`** is the only way UI code and the MCP bridge change
  state. `createWorkspace({ clock, newId, policy })` builds a store and a
  registry with every command in `ALL_COMMANDS` registered.

## Command anatomy

```ts
export const setColumnType = defineCommand({
  name: 'setColumnType',            // camelCase, stable: MCP clients call it by name
  description: 'Sets a column type…', // becomes the MCP tool description
  input: z.strictObject({ column: ColumnNameSchema, type: ColumnTypeSchema }),
  tier: 'edit',
  mcp: true,                        // or { exempt: MCP_EXEMPTIONS.<name> }
  apply(draft, input, ctx) {        // pure and synchronous; mutate the draft
    const column = draft.columns.find((c) => c.name === input.column);
    if (!column) throw new CommandError('precondition_failed', 'Unknown column …');
    column.typeOverride = input.type === column.inferredType ? null : input.type;
  },
});
```

- Use `z.strictObject` so a misspelt key is an error, not a silent no-op.
- `apply` gets `ctx.now` and `ctx.newId(prefix)` from the clock and id
  generator injected into the store. Never call `Date.now()` or
  `Math.random()` in core.
- Throw `CommandError('precondition_failed', …)` when valid input does not fit
  the state; Immer discards the draft and nothing is recorded. Messages name the
  field and what was expected, since an MCP client returns them to the model.
- Every failure a caller can fix rejects with `CommandError` (`code`:
  `unknown_command`, `invalid_caller`, `invalid_input`, `forbidden`,
  `precondition_failed`; `issues` lists `{ path, message }`; `toJSON()` gives
  the IPC/MCP form).

## Tiers

| Tier | Runs when | Hook |
| --- | --- | --- |
| `read` | Always. Must not change state (a change throws). | none |
| `edit` | Always. Undoable. | none |
| `write` | `policy.confirmWrite(request)` resolves true | host-supplied |
| `raw` | `policy.allowRaw(request)` resolves true | host-supplied |

A missing hook refuses the tier. The hook receives `{ command, tier, caller,
input }` and may be async, so the desktop host can show a confirmation for AI
callers, let a person's own click through, and read the per-workspace raw-row
opt-in from app state. `dispatch` returns a promise, but `read` and `edit`
commands apply synchronously before it returns, so UI dispatches keep their
order.

Commands with an MCP exemption are also refused for `caller: 'ai'`, so an
exemption is a real boundary, not just a missing tool.

## The async action pattern

Commands are synchronous and pure. Anything that waits (dialogs, the engine,
the file system) happens in an **action** outside the registry, which then
dispatches a command with the results:

```ts
// renderer, e.g. apps/desktop/src/renderer/actions/open-file.ts
async function openFileAction(registry: CommandRegistry, engine: QueryService) {
  const picked = await window.glassgrid.openCsv();             // main: native dialog → handle
  if (!picked) return;
  const profile = await engine.open(picked.handle);            // engine: fingerprint + inferred columns
  await registry.dispatch('openFile', {
    handleId: picked.handle,
    fileName: picked.name,
    fingerprint: profile.fingerprint,
    columns: profile.columns.map((c) => ({ name: c.name, type: c.type })),
  }, { caller: 'user' });
}
```

The undo entry then holds only the state change, so undo never re-runs engine
work. Views react to the new state and issue their own queries. `openFile` is
MCP-exempt for exactly this reason: its input is engine-produced metadata an
external caller cannot supply truthfully.

## Undo entries

Each state-changing dispatch records
`{ id, name, caller, input, patches, inversePatches, at }`. Person and AI share
one stack; `caller` drives "by AI" labels in history and the activity panel.

- `undo` applies the latest entry's inverse patches; `redo` reapplies its
  patches. Both are registered commands (tier `edit`, MCP-exposed), so an AI
  can step back too, but they are never recorded as entries. Their `entryId` is
  the entry they moved, or null when there was nothing to move.
- Any new state change clears the redo stack. A command that changes nothing
  records nothing, notifies nobody and keeps the redo stack.
- Opening a file is one entry; undo restores the previous workspace.
- History keeps the latest 1000 entries (`historyLimit`).
- Subscribers are notified exactly once per state change.

A fast-check property test runs random command sequences (including undo and
redo by either caller) and checks that undoing everything returns the initial
state and redoing everything returns the final one.

## Parity enforcement

Every command declares `mcp: true` or `mcp: { exempt: MCP_EXEMPTIONS.<name> }`.
`mcp-exemptions.ts` is the single reviewable list of parity gaps, with reasons.
`parity.test.ts` runs `checkMcpParity(registry.definitions(), MCP_EXEMPTIONS)`
over the full registry and fails when a command has no declaration, an
exemption has no reason, an exempt command is missing from the file or has a
different reason there, or the file lists a command that is exposed or does not
exist. `register` also refuses commands without a valid declaration.

New commands go in `ALL_COMMANDS` (`commands/all.ts`) so the parity test,
`list()` (the future MCP `list_commands`) and the UI see the same set.

## Integration notes

- `ChartSpecLike` and `FilterLike` in `state/workspace.ts` are placeholders for
  the real `ChartSpec` and filter schemas from `packages/core/src/spec/`.
- `ColumnType` in `state/workspace.ts` is a local union to be reconciled with
  the compiler's column type.
- `Fingerprint` (`sizeBytes`, `mtimeMs`, `sampleHash`) should match what the
  engine's `open` returns.
- Agent commands should queue while a brush is in progress (see the design
  doc); that gate belongs in the renderer around `dispatch` and is not built
  yet.

# M4 notes: workspace persistence

How Glassgrid saves and opens `.glassgrid` workspaces, recovers unsaved work
after a crash and asks before closing. Built on branch `m4-persist`; dated
2026-10-18. Design decision: [technical-design.md → Persistence](technical-design.md#persistence).

| Piece | Where |
| --- | --- |
| File format, persisted subset, migrations, restore, dirty tracking | `packages/core/src/workspace-file/` (pure; no Node, DOM or Electron) |
| Commands | `packages/core/src/commands/builtins/workspace.ts` |
| Bridge payload schemas, channels, `WorkspaceBridge` type | `packages/core/src/protocol/workspace.ts`, `protocol/ipc.ts` |
| Renderer glue (effect handlers, recovery reporter, close answer) | `packages/core/src/workspace-file/host.ts` |
| Main process | `apps/desktop/src/main/persistence/` (Electron-free modules) wired in `main/index.ts` |
| Preload API | `apps/desktop/src/preload/index.ts` → `window.glassgrid.workspace` |
| Fixtures | `packages/core/test/fixtures/workspace/*.glassgrid` |

## The file format (version 1)

A `.glassgrid` file is UTF-8 JSON (two-space indent, trailing newline, keys in
a fixed order so saving the same workspace twice gives the same bytes). It
never contains data rows.

```json
{
  "formatVersion": 1,
  "app": { "name": "Glassgrid", "version": "1.0.0" },
  "savedAt": "2026-10-18T09:30:00.000Z",
  "data": {
    "fileName": "trips 2026.csv",
    "absolutePath": "/Users/ada/data/trips 2026.csv",
    "relativePath": "../data/trips 2026.csv",
    "fingerprint": {
      "sizeBytes": 1284533771,
      "mtimeMs": 1760000000000,
      "headTailSha256": "3f1d9c0b6a2e4f8d7c5b3a1908e7d6c5b4a39281706f5e4d3c2b1a0918273645",
      "key": "9b2f0c4d1e3a5b7c9d0e1f2a3b4c5d6e"
    }
  },
  "workspace": {
    "columns": [
      { "name": "pickup_at", "inferredType": "timestamp", "typeOverride": null },
      { "name": "fare_amount", "inferredType": "float", "typeOverride": null },
      { "name": "vendor_id", "inferredType": "integer", "typeOverride": "text" }
    ],
    "charts": [
      {
        "id": "chart_1",
        "spec": { "mark": "line", "x": { "column": "pickup_at", "timeUnit": "day" }, "y": { "column": "fare_amount", "aggregate": "sum" }, "filters": [] },
        "title": "Fares per day"
      },
      { "id": "chart_2", "spec": { "mark": "histogram", "x": { "column": "fare_amount", "bin": "auto" }, "filters": [] } }
    ],
    "selections": {
      "chart_2": {
        "source": "brush",
        "clauses": [
          { "channel": "x", "filter": { "kind": "range", "column": "fare_amount", "min": 10, "max": 40, "minInclusive": true, "maxInclusive": false } }
        ]
      }
    },
    "userFilters": [{ "id": "filter_1", "filter": { "kind": "notNull", "column": "vendor_id" } }],
    "grid": {
      "sort": [{ "column": "fare_amount", "direction": "desc" }],
      "columnOrder": ["fare_amount", "pickup_at"],
      "columnWidths": [{ "column": "vendor_id", "width": 96 }]
    },
    "layout": {
      "cards": [
        { "chartId": "chart_1", "x": 0, "y": 0, "w": 2, "h": 1 },
        { "chartId": "chart_2", "x": 2, "y": 0, "w": 1, "h": 1 }
      ]
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `formatVersion` | Integer. Current: 1. Files are only ever written in the current version. |
| `app` | Name and version of the app that wrote it (informational). |
| `savedAt` | ISO 8601 with offset, from main's clock. |
| `data.fileName` | Display name of the data file. Automatic relinking only opens a file with exactly this name. |
| `data.absolutePath` | Where the data was when saved. |
| `data.relativePath` | The data's path relative to the workspace file's folder, with `/` separators on every OS; `null` when there is none (another drive on Windows). |
| `data.fingerprint` | The engine fingerprint (`fingerprintFile`): size, mtime (ms, truncated), SHA-256 of the first and last 1 MB, and the Parquet cache key. |
| `workspace` | The persisted subset of `WorkspaceState` (below), validated with the same Zod schemas as the core state (`ChartSpecSchema`, `FilterSchema`, `SelectionSchema`, …). |
| `recoveryOf` | Only in crash-recovery snapshots: `{ workspacePath: string \| null }`. Never in a file the person saves. |

Every object is strict: unknown keys are errors, not silently dropped. Ids
used as record keys follow the state's safe-id alphabet (Zod also skips a
`__proto__` key outright), so a file cannot pollute prototypes.

### What persists, and why

| Saved | Not saved | Why not |
| --- | --- | --- |
| Columns: name, inferred type, type override | Column profiles | Recomputed from the data on open (and would go stale) |
| Charts: id, spec, title; layout cards | Grid cell selection (`grid.selection`) | View state; its rows index the current view and go stale (M2 notes) |
| Selections per view: brushes, clicked marks, filter selections (incl. the grid's own) | Undo/redo history | Session state; the file is the result, not the steps |
| User filters ("+ Filter" chips) | The data handle, `document` | Per session; main issues new ones on open |
| Grid sort, column order, column widths | AI/MCP settings, raw-row access | App state on this machine, never in a shareable file (design → Persistence) |

The inferred type is saved so opening can tell the person when the data now
reads differently. Brushes are saved because they are part of the analysis:
a saved, cross-filtered dashboard reopens cross-filtered.

### Reading a file: `parseWorkspace(json)`

`parseWorkspace(text | value) → { file, workspace, data, migratedFrom, warnings }`
migrates, then validates. It throws `WorkspaceFileError` with a `code` and a
message written for the person:

| Code | When |
| --- | --- |
| `invalid_json` | Not JSON (e.g. truncated). |
| `not_a_workspace` | JSON without an integer `formatVersion`. |
| `newer_version` | `formatVersion` above the current one: "This workspace was saved by a newer version of Glassgrid (format 2; this version reads up to 1). Update Glassgrid to open it." Never guessed at. |
| `unsupported_version` | An old version with no migration (should not exist for released versions). |
| `invalid_file` | Fails the schema; `issues` lists `{ path, message }` (e.g. `workspace.charts[1].spec.mark`). |

`serializeWorkspace(stateOrSnapshot, meta)` validates what it writes, so a
state that would not load again is never saved (`invalid_file`).

### Restoring: `restoreWorkspace(saved, data, document)`

The data decides what exists. Columns come from the engine's `open` of the
relinked file; saved overrides are applied by name (an override equal to the
new inferred type is dropped). Anything that refers to a column the data no
longer has is dropped with a warning, so the result is always a valid state:
charts (`chart_dropped`, naming the chart and the columns), selections
(`selection_dropped`), user filters (`filter_dropped`), sort keys
(`grid_trimmed`), widths and order entries (silently). Selections on views
that are not charts are dropped; cards are deduplicated and missing ones
added (`layout_repaired`). New columns (`column_added`) and changed inferred
types (`column_type_changed`) are reported. Profiles and the grid selection
start empty. Warnings are `{ code, message }` (`WorkspaceWarningSchema`).

## Migrations

`migrations.ts` holds `CURRENT_FORMAT_VERSION`, `OLDEST_FORMAT_VERSION` and
`MIGRATIONS[n]: (vN) => vN+1`. On open, `migrateWorkspaceFile` runs every
migration from the file's version up to the current one, in order; the result
is validated with the current schema and a `migrated` warning is returned.

Policy for every format change:

1. Bump `CURRENT_FORMAT_VERSION`; keep the old version's schema in
   `migrations.ts` so the migration validates its input.
2. Add `MIGRATIONS[old]`, pure and total over valid old files (never lose
   work: v0 → v1 turns filters that do not fit a selection into user filters).
3. Commit at least one fixture `vN-*.glassgrid` written by the old version;
   never regenerate fixtures. The fixture test fails if a version between
   `OLDEST_FORMAT_VERSION` and the current one lacks a fixture or a migration.
4. Adding an optional field is still a format change (files are strict).

Version 0 is the pre-release M1 shape (absolute path only, filters per view,
no user filters, grid sort only); `v0-basic.glassgrid` and its test prove the
path. Fixtures today: `v0-basic`, `v1-full` (byte-for-byte what the taxi test
workspace saves), `v1-minimal` (Windows paths, offset timestamp),
`future-v2`, `invalid-truncated`, `invalid-v1-unknown-mark`.

## Dirty tracking

`WorkspaceState.document` (optional, JSON) is `{ id, fileName, savedDigest }`:
main's opaque document id, the file's display name, and `persistedDigest` of
the workspace as last saved or opened. `isWorkspaceDirty(state)` is true when
a data file is open and the persisted subset's digest differs from
`savedDigest` (or there is none). It is derived, not a flag, so:

- profiles, the grid selection and history never make a workspace dirty;
- undoing back to the saved state makes it clean again; undoing past it
  makes it dirty;
- `openFile` starts an untitled workspace that is clean until something
  changes (closing right after opening a CSV does not ask);
- a recovery snapshot, or a workspace whose restore had to drop something,
  opens dirty.

The digest is a 64-bit non-cryptographic hash of the canonical (key-sorted)
JSON of the persisted subset (`digest.ts`). Known edge: after Save, undoing
`loadWorkspace` and redoing it brings back the digest from load time, so the
workspace looks clean although the file now holds the later save.

## Commands

| Command | Kind / tier | MCP | Notes |
| --- | --- | --- | --- |
| `saveWorkspace {}` | effect, `write` | exposed | Saves to `document.id`'s file, Save As when there is none. |
| `saveWorkspaceAs {}` | effect, `write` | exposed | Native save dialog. |
| `openWorkspace { source: 'dialog' } \| { source: 'recent', id } \| { source: 'external', token }` | effect, `edit` | exposed | Replaces the workspace (undoable). AI callers: `recent` only. |
| `listRecentWorkspaces {}` | effect, `read` | exposed | `[{ id, fileName, lastOpenedAt }]` (no folders). |
| `loadWorkspace { data, workspace, document, recovered }` | state, `edit` | exempt | The state change behind every open; one undo entry. |
| `markWorkspaceSaved { documentId, fileName, savedDigest }` | state, `edit`, `undoable: false` | exempt | Records a completed save. |

**AI rules.** Saving is `write` tier: it runs only when the host's
`confirmWrite` allows it (the desktop policy refuses AI callers until the
confirmation UI exists, as for `copySelection`), and the path is always the
document's own file or one the person picks in a native dialog. Opening is
`edit` tier because it only replaces state (undo restores the previous
workspace), but an AI caller may only open an entry of the recent list:
`dialog` would choose a file on the person's behalf and `external` acts on an
OS hand-off. The rule is a new `checkCaller(input, caller)` hook on effect
commands, enforced by the registry before the tier policy and the host
handler, so every host applies it. No command takes a path. `loadWorkspace`
and `markWorkspaceSaved` are exempt because their inputs (engine metadata,
main's document ids, digests of what was written) only the app can supply.

**Attribution gap.** The effect handler dispatches `loadWorkspace` as caller
`user` (the exempt command refuses `ai`), so an AI-initiated open is logged as
the `openWorkspace` call, not as a "by AI" undo entry.

## Main process

All in `apps/desktop/src/main/persistence/`, Electron-free (dialogs, ipcMain,
windows are injected), wired in `main/index.ts`.

### Saving

`WorkspaceService.save` writes to the path behind `documentId`; an unknown or
null id falls through to `saveAs`. Save As opens the native dialog with
`defaultPath` = the current file, else `<data folder>/<data name>.glassgrid`,
the filter "Glassgrid workspace (.glassgrid)", `createDirectory` and
`showOverwriteConfirmation`; `.glassgrid` is appended when the dialog did not
add it. The data reference is built from the handle's path (main's
`EngineHost.pathOf`) and the target path. A successful save adds the file to
the recent list (and the OS recent documents) and deletes the window's
recovery snapshot unless the window reported newer work while saving.

### Atomic writes

`writeFileAtomic(path, data)`: create `.<name>.<random>.gg-tmp` in the same
folder (`wx`), write in chunks, `fsync`, close, rename over the target, then
`fsync` the folder (skipped on Windows, where a locked target is retried a few
times). Any failure deletes the temp file and leaves the target untouched. An
existing file keeps its permissions; a symlink keeps pointing at the replaced
file. A crash leaves at worst a stray temp file; `removeStaleTempFiles` sweeps
ones older than a minute before saving next to a workspace, and in the
recovery and app-state folders. Fault-injection hooks (`afterChunk`,
`beforeRename`) exist for tests only (they are a parameter, not an
environment switch). The test kills a child process with SIGKILL in the
middle of an 8 MB write and checks the old file is byte-identical.

### Opening and relinking

```
open(dialog | recent id | OS token)  /  openDropped(File)  /  restoreRecovery(id)
  → read (≤ 32 MB) → parseWorkspace (migrate, validate)          failed { code, message }
  → relative path (against the workspace file's folder)  ─┐
  → absolute path                                        ─┤ only a regular file named data.fileName
  → neither: needsData { token, dataFileName }            │
        → locateData(token): native open dialog (near the workspace) — Cancel keeps the token
  → fingerprintFile(found) vs saved  → fingerprintMismatch { sizeBytes?, mtimeMs?, contentChanged } | null
  → engine.registerFile(found)  (exactly like opening a CSV) → handle
  → opened { documentId, workspaceFile, file: { handle, displayName, sizeBytes },
             dataFoundBy: relative|absolute|located, workspace, warnings, migratedFrom, recovered }
renderer: engine.open(handle) → loadWorkspace(restoreWorkspace over the engine's columns)
```

The fingerprint function is the engine's (`fingerprintFile` from
`@glassgrid/engine`, called with the native driver's `nodeFiles`). Modification times within 2 s count as equal (copies
between file systems round preserved timestamps; the E2E copy shifted one by
1 ms); the Parquet cache key is not compared. A mismatch never blocks the
open: the UI should warn ("sales.csv has changed since this workspace was
saved: 1.2 GB → 1.3 GB, contents differ").

### Autosave and crash recovery

The renderer reports its unsaved work (`updateRecovery({ documentId,
snapshot })`, or `null` once clean) whenever it changes; `reportUnsavedWork`
in core does this deduplicated by digest. Main's `Autosaver` writes each
window's latest report at most every **5 s** (`DEFAULT_AUTOSAVE_INTERVAL_MS`),
only when it changed, to `<userData>/recovery/<rs_id>.glassgrid`: the normal
format plus `recoveryOf`, relative path computed against the workspace file
the work belongs to, mode 0600, atomically. It never writes the person's
file. The snapshot is deleted on a clean save, on "Don't Save", on a clean
close and on `discardRecovery`. When a window closes without an answer
(hung renderer) or the app crashes, it stays.

`listRecovery()` (call it at launch) returns snapshots from earlier sessions,
newest first: `{ id, workspaceFile: { fileName, directory } | null,
dataFileName, savedAt }`. It deletes unreadable ones and ones older than the
workspace file they belong to (it was saved after the snapshot), and skips
snapshots owned by open windows. `restoreRecovery(id)` relinks like an open
(result has `recovered: { id, savedAt }`, the original `documentId`, so Save
goes back to the original file) and the window takes the snapshot over. A
window's previous snapshot is never deleted implicitly.

### Recent workspaces and app state

`<userData>/state.json`: `{ "version": 1, "recentWorkspaces": [{ "path",
"lastOpenedAt" }] }`, written atomically (0600) with writes serialised. At
most 10 entries, newest first, deduplicated; entries whose file disappeared
are pruned when the list is read. A corrupt or newer-version file starts
fresh. The renderer gets `{ id: rw_<sha256(path)[:24]>, fileName, directory,
lastOpenedAt }`. Raw-row access, MCP and window settings belong here later,
never in a workspace file.

### Close with unsaved changes

Each window has a `CloseGuard`. On `close` main prevents it, sends
`workspace-close-query` with a request id and waits up to 3 s for the reply
on `workspace-close-reply` (only from that window's webContents):

- no handler registered, a throwing handler, or no reply → close; keep (and
  flush) the recovery snapshot;
- `{ dirty: false }` → close; delete the snapshot;
- `{ dirty: true, documentId, snapshot }` → native dialog "Do you want to save
  the changes you made to trips.glassgrid?" with **Save / Don't Save /
  Cancel**. Save writes the snapshot from the answer (Save As when untitled)
  and closes only if it was saved; a failed save shows an error box and keeps
  the window; Cancel keeps it.

Quitting (Cmd+Q, last window on Windows/Linux) goes through the same prompt
per window: a cancelled close cancels the quit; after each window agreed main
calls `app.quit()` again. The engine now stops on `will-quit` (after every
window agreed), not `before-quit`.

### File associations and OS hand-offs

`electron-builder.yml` registers `.glassgrid` (`Glassgrid Workspace`,
`application/vnd.glassgrid.workspace+json`, role Editor). macOS `open-file`
(also before `ready`), `.glassgrid` arguments in `process.argv` at launch and
in `second-instance` (the app now holds the single-instance lock, except
under E2E) become single-use `ot_` tokens. They are queued until a renderer
subscribes with `onOpenRequest`, then pushed to the focused window. The
renderer decides when to open (after asking about its own unsaved work) with
`openWorkspace({ source: 'external', token })`.

### Menu

File → Open Workspace… (Cmd/Ctrl+Shift+O), Open Recent (one item per recent
workspace), Save Workspace (Cmd/Ctrl+S), Save Workspace As…
(Cmd/Ctrl+Shift+S), sent on their own channel (`workspace-menu-command`,
`{ kind: 'openWorkspace' | 'openRecentWorkspace' (with the entry's id) |
'saveWorkspace' | 'saveWorkspaceAs' }`) so the existing `MenuCommand` union
is unchanged. The menu is rebuilt when the recent list changes
(`onRecentChanged`).

## Security notes

- Paths never reach the renderer except the workspace file's display name and
  folder (title bar, recent list). Data files only cross as engine handles;
  results are checked in tests not to contain the data path.
- Every channel checks the sender (top-level frame of the app's own origin,
  `sender-guard.ts`) before parsing, then parses with the core schemas: ids
  must match `doc_…`, `rw_…`, `ot_…`, `rs_…`, so a request cannot smuggle a
  path. Dropped files go through `webUtils.getPathForFile` in the preload and
  must be absolute, regular `.glassgrid` files.
- A crafted workspace cannot make the app open an arbitrary file: automatic
  relinking only opens a regular file whose name equals `data.fileName`;
  anything else needs the person to pick it. Workspace files over 32 MB are
  refused before parsing.
- Workspace files hold no rows, no AI settings and no raw-row access, so they
  are safe to email or commit. Recovery snapshots and `state.json` live in
  the user-data folder with 0600 permissions.
- AI callers cannot choose paths: saving is `write` tier (refused or
  confirmed by the person), opening is limited to the recent list.

## Preload API for the integration step

`window.glassgrid.workspace` (`WorkspaceBridge` in `packages/core/src/protocol/ipc.ts`):

| Method / event | Returns | Use |
| --- | --- | --- |
| `save(request: { documentId, snapshot })` | `SaveWorkspaceResult` | Cmd+S. Prefer the `saveWorkspace` command, which calls it and dispatches `markWorkspaceSaved`. |
| `saveAs(request)` | `SaveWorkspaceResult` | Cmd+Shift+S (`saveWorkspaceAs`). |
| `open(request: { source: 'dialog' } \| { source: 'recent', id } \| { source: 'external', token })` | `OpenWorkspaceResult` | Behind `openWorkspace`. |
| `openDropped(file: File)` | `OpenWorkspaceResult` | A dropped `.glassgrid` (route by extension; CSVs keep `openDroppedFile`). |
| `locateData(token)` | `OpenWorkspaceResult` | After `needsData`, when the person clicks "Locate…". `cancelled` keeps the token. |
| `cancelOpen(token)` | `void` | The person dismissed the locate prompt. |
| `listRecent()` | `RecentWorkspace[]` | Recent list (start screen, File menu). |
| `listRecovery()` | `RecoverySnapshotInfo[]` | At launch: offer "Restore unsaved work". |
| `restoreRecovery(id)` / `discardRecovery(id)` | `OpenWorkspaceResult` / `void` | The offer's two buttons. |
| `updateRecovery(update \| null)` | (send) | Feed with `reportUnsavedWork(store, bridge.workspace.updateRecovery)`. |
| `onOpenRequest(listener)` | unsubscribe | OS hand-offs `{ token, fileName }`; queued ones arrive on subscribe. |
| `onCloseRequest(handler)` | unsubscribe | `() => closeAnswer(store.getState())`. One handler per window. |
| `onMenuCommand(listener)` | unsubscribe | `{ kind: 'openWorkspace' \| 'saveWorkspace' \| 'saveWorkspaceAs' }`. |

Every result type has a Zod schema in `protocol/workspace.ts`
(`OpenWorkspaceResultSchema`, …); `completeWorkspaceOpen` parses it.

Wiring sketch for the renderer (all from `@glassgrid/core`):

```ts
const { registry, store } = workspace;
const ws = window.glassgrid.workspace;
const deps = { registry, bridge: ws, openTable: async (h) => (await engine.open(h)).table };

provideWorkspacePersistence(deps);                         // saveWorkspace, saveWorkspaceAs, openWorkspace, listRecentWorkspaces
reportUnsavedWork(store, (update) => ws.updateRecovery(update));
ws.onCloseRequest(() => closeAnswer(store.getState()));
ws.onMenuCommand((c) => void registry.dispatch(c.kind, c.kind === 'openWorkspace' ? { source: 'dialog' } : {}, { caller: 'user' }));
ws.onOpenRequest(({ token }) => void registry.dispatch('openWorkspace', { source: 'external', token }, { caller: 'user' }));

// drop:      completeWorkspaceOpen(deps, await ws.openDropped(file))
// needsData: show "Locate trips.csv…" → locateWorkspaceData({ ...deps, bridge: ws }, token)
// launch:    const offers = await ws.listRecovery(); restore → completeWorkspaceOpen(deps, await ws.restoreRecovery(id))
// title:     state.document?.fileName ?? 'Untitled', with a dot when isWorkspaceDirty(state)
```

`openWorkspace`'s value is an `OpenWorkspaceOutcome`: `opened` (with
`warnings`, `fingerprintMismatch`, `dataFoundBy`, `recovered`), `needsData`
(`token`, `dataFileName`), `cancelled` or `failed` (`code`, `message`). After
`opened`, re-send type overrides to the engine as after `setColumnType`
(the engine opened the file with inferred types) and request profiles as
after `openFile`.

## Tests

| File | Covers |
| --- | --- |
| `core/src/workspace-file/workspace-file.test.ts` (24) | Digest, persisted subset, dirty rules, serialize/parse round trip, fixed key order, no rows/profiles/selection/handle, error codes and issue paths, prototype keys, BOM, the migration runner (made-up v0→v3 chain, gaps, newer), `restoreWorkspace` drops and warnings |
| `core/test/workspace-file.fixtures.test.ts` (9) | A fixture per version and a migration per old version; each fixture opens and re-saves; `v1-full` byte-for-byte; v0 → v1 details; newer, truncated and invalid fixtures |
| `core/test/workspace-file.property.test.ts` (2 × 300 runs) | Random valid states: serialize → parse equals the persisted subset (ephemeral fields dropped, digest equal, stable bytes); restore over the same data equals the state minus ephemeral fields, clean, no warnings |
| `core/src/commands/workspace-commands.test.ts` (17) | Dirty through commands and undo, `loadWorkspace` (one entry, undo, recovered/dropped → dirty, AI refused), `markWorkspaceSaved` (no entry), effect handlers with a fake bridge (save marks clean, edits during a save stay dirty, cancel/fail, write tier, AI open rule incl. before `unavailable`, needsData/failed pass-through, unreadable data), recovery reporter, close answer |
| `desktop/src/main/persistence/*.test.ts` (70) | Atomic write (replace, modes, symlink, hook failures, SIGKILL mid-write, temp sweep); relink order, name check, mismatch details and tolerance, names; recent list (order, cap, prune, corrupt file, concurrency); recovery listing/cleanup and the autosaver; the service end to end on temp folders with fake dialogs (Save As defaults, relative/absolute/locate, mismatch, recent, OS tokens, recovery after a crash, stale snapshots); IPC sender checks on every channel, schema validation, drop checks; close guard (every button, timeout, foreign replies); argv and the open-request queue |
| `desktop/e2e/workspace-file.spec.ts` (1) | The real app: Save As, recent, reopening a copied project by relative path, autosave to the recovery folder, close without saving, restore after relaunch |

## UI

Built on branch `m4-desktop-ui`. The app (`packages/app`) owns the UI and
wires core's glue in `src/workspace-files.ts` (`useWorkspaceFiles`); the
desktop shell passes the preload bridge as `Platform.workspaceFiles`
(`WorkspaceFilesApi` = `WorkspaceBridge` minus the window events) with
`capabilities.canSaveWorkspace: true`. Without both, none of this shows.

- **One dirty model.** The edited dot, the window title and the close
  prompt read core's `isWorkspaceDirty` (digest of the persisted subset), so
  undoing back to the saved state is clean again and profiles or the grid
  selection never count. The app's history-based indicator and its 2 s
  `autosave` timer are gone: the only autosave path is `reportUnsavedWork`
  → `updateRecovery` → main's 5 s `Autosaver`.
- **Commands only.** Save, Save As, Open Workspace…, Open Recent and OS
  hand-offs all dispatch `saveWorkspace`, `saveWorkspaceAs` and
  `openWorkspace` (implemented by `provideWorkspacePersistence`), whether
  they come from the title bar, the start screen, a shortcut or the menu.
  Drops, the locate prompt and recovery finish through
  `completeWorkspaceOpen` / `locateWorkspaceData`, whose state change is
  `loadWorkspace`. The start screen reads `listRecent` directly (it shows the
  folder, which `listRecentWorkspaces` withholds from agents).
- **Menus and shortcuts.** `PlatformWindow.onMenuCommand` now carries
  `MenuCommand | WorkspaceMenuCommand` (the desktop merges both channels).
  File has Open CSV… (⌘O), Open Workspace… (⇧⌘O), **Open Recent** (rebuilt
  when the recent list changes; items send `openRecentWorkspace { id }`),
  Save Workspace (⌘S) and Save Workspace As… (⇧⌘S). These are menu
  accelerators, so the desktop sets `PlatformWindow.menuShortcuts` and the
  page leaves those keys alone (each fires once); without a native menu
  (browsers) the page handles them. Undo/redo stay in the page.
- **Title.** The title bar names a saved workspace by its file
  (`workspace-name`), followed by the data file and size; untitled work is
  named by its data file. The dot after the size is the edited state. The
  window title is `trips.glassgrid — Glassgrid` with a leading `●` when
  edited on Windows/Linux; on macOS main sets `setRepresentedFilename` and
  `setDocumentEdited` (`PlatformWindow.setDocumentChrome` →
  `WorkspaceBridge.setDocumentState`, a fire-and-forget channel that sends
  the document id; main resolves the path itself).
- **Close prompt.** `PlatformWindow.onCloseRequest` is the veto hook; the
  desktop maps it to `ws.onCloseRequest(() => closeAnswer(state))` and main
  shows the native Save / Don't Save / Cancel box.
- **Opening.** `needsData` opens a modal "Where is trips.csv?" dialog
  (`role="alertdialog"`, focus moved to "Locate trips.csv…", Tab kept inside,
  Escape = Cancel, the rest of the window `inert`): Locate… runs
  `locateData` (a cancelled picker keeps the dialog; a failure is shown in
  it), Cancel runs `cancelOpen`. A fingerprint mismatch opens the workspace
  and shows a non-blocking banner (`role="alert"`): "trips.csv has changed
  since this workspace was saved (1.20 MB → 1.31 MB, contents differ).
  Charts and counts may differ…" with **Locate another file…** and
  **Continue**. For that, main now keeps the open's context under a
  `relinkToken` (new optional field of the `opened` result) that
  `locateData` accepts; Continue (or showing other data) forgets it with
  `cancelOpen`. Restore warnings (dropped charts, migration) are toasted.
- **Column types after open.** The engine opens the data with inferred
  types; the app's override effect sees a new table and sends the restored
  overrides with `setColumnTypes` before the profile, as after an engine
  restart. Values that fail to cast are reported without an Undo action
  (undo would undo the whole open).
- **Start screen.** "Open workspace…" next to "Open CSV…"; unsaved work from
  earlier sessions (`listRecovery`) as a `role="status"` banner with Restore
  and Discard per entry (restored work opens dirty, so Save returns to its
  file); and up to five recent workspaces (file name and folder). A dropped
  `.glassgrid` goes to `openDropped`; anything else is opened as data.

Tests: `packages/app/src/App.workspace-files.test.tsx` (17: digest dot and
undo, save/Save As and the title, failures, autosave reports and the close
answer, shortcuts with and without a native menu, menu items, open with
override re-send, warnings, the locate dialog's focus trap and outcomes, the
mismatch banner, OS hand-offs and drops, recent list, recovery
restore/discard); `desktop-platform.test.ts` (a full fake `WorkspaceBridge`);
`workspace-service.test.ts` and `ipc.test.ts` (relink token, recent-list
hook, document state); `e2e/workspace-ui.spec.ts` (4, the real app: save
from the File menu, dirty dot incl. undo back to clean, reopen from the
start screen with the override applied by the engine, File → Open Recent,
the close veto (Cancel, then Save), the locate prompt for a moved and changed
data file with the banner, restore after SIGKILL; axe on the start screen
and the dialog). Playwright's synthetic keys reach the page, not Electron's
menu accelerators, so the E2E clicks the menu items (and checks their
accelerators).

## Left for integration

- ~~Ask before replacing a dirty workspace when opening another one or a
  CSV.~~ Done on `pres-polish`: `useWorkspaceFiles().confirmReplace` runs
  before every replacing open the person starts (Open CSV from any entry
  point, a dropped file, Open workspace, Open Recent, OS hand-offs). With
  unsaved work (`isWorkspaceDirty`) it shows a modal "Save changes to
  trips.glassgrid?" (`SaveBeforeReplaceDialog`, the shared `Dialog`):
  **Save** / **Save as…** dispatches `saveWorkspace` and the open goes
  ahead only once saved; **Don't save** goes ahead; **Cancel** or Escape
  opens nothing. The commands themselves still do not ask (an agent's
  `openWorkspace { source: 'recent' }` replaces the workspace, and undo
  restores it). Tests: `App.workspace-files.test.tsx` (4) and
  `e2e/workspace-ui.spec.ts` (Cancel, then Save as… from File → Open CSV).
- The fingerprint-mismatch banner now takes its own row between the title
  bar and the panels instead of floating over the grid.
- The AI confirmation UI for `write` tier (M6) before agents can save.
- Web demo: the same format saved to OPFS or downloaded; implement
  `WorkspaceFilesApi` in `web-platform.ts` (the app UI is host-neutral).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { COLUMN_TYPES, createInitialWorkspaceState } from '../state/workspace.js';
import { openFileInput, testWorkspace } from './test-support.js';

const callerArb = fc.constantFrom('user' as const, 'ai' as const);
const typeArb = fc.constantFrom(...COLUMN_TYPES);

const openArb = fc.record({
  kind: fc.constant('open' as const),
  caller: fc.constant('user' as const),
  fileName: fc.constantFrom('a.csv', 'b.csv', 'sales 2026.csv'),
  columns: fc.uniqueArray(fc.record({ name: fc.constantFrom('id', 'x', 'y', 'date', 'Ünïcode', 'a b'), type: typeArb }), {
    selector: (column) => column.name,
    maxLength: 6,
  }),
});
const setTypeArb = fc.record({
  kind: fc.constant('setType' as const),
  caller: callerArb,
  index: fc.nat({ max: 10 }),
  type: typeArb,
});
const historyArb = fc.record({ kind: fc.constantFrom('undo' as const, 'redo' as const), caller: callerArb });

const opArb = fc.oneof({ arbitrary: openArb, weight: 1 }, { arbitrary: setTypeArb, weight: 4 }, { arbitrary: historyArb, weight: 2 });

describe('undo/redo (property)', () => {
  it('undoing everything restores the initial state and redoing everything restores the tip', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { maxLength: 40 }), async (ops) => {
        const { registry, store } = testWorkspace();
        const initial = createInitialWorkspaceState();

        for (const op of ops) {
          if (op.kind === 'open') {
            await registry.dispatch(
              'openFile',
              openFileInput({ fileName: op.fileName, columns: op.columns }),
              { caller: op.caller },
            );
          } else if (op.kind === 'setType') {
            const columns = store.getState().columns;
            const column = columns[op.index % Math.max(columns.length, 1)];
            if (column === undefined) continue;
            await registry.dispatch('setColumnType', { column: column.name, type: op.type }, { caller: op.caller });
          } else {
            await registry.dispatch(op.kind, {}, { caller: op.caller });
          }
        }

        // Ops may end mid-undo; the tip is the state with every entry applied.
        while (store.canRedo()) await registry.dispatch('redo', {}, { caller: 'user' });
        const tip = store.getState();
        const entries = store.getHistory().past.length;
        expect(JSON.parse(JSON.stringify(tip))).toEqual(tip);

        for (let i = 0; i < entries; i++) await registry.dispatch('undo', {}, { caller: 'ai' });
        expect(store.canUndo()).toBe(false);
        expect(store.getState()).toEqual(initial);

        for (let i = 0; i < entries; i++) await registry.dispatch('redo', {}, { caller: 'user' });
        expect(store.canRedo()).toBe(false);
        expect(store.getState()).toEqual(tip);
        expect(store.getHistory().past).toHaveLength(entries);
      }),
      { numRuns: 300 },
    );
  });
});

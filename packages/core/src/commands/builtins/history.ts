import { z } from 'zod';
import type { HistoryCommand } from '../define.js';

const NoInputSchema = z.strictObject({});

/** Reverts the latest change, whoever made it (person and AI share one stack). */
export const undo: HistoryCommand = Object.freeze({
  kind: 'history',
  direction: 'undo',
  name: 'undo',
  description: 'Reverts the most recent workspace change, whether a person or an AI made it.',
  input: NoInputSchema,
  tier: 'edit',
  mcp: true,
});

/** Re-applies the most recently undone change. Any new change clears the redo stack. */
export const redo: HistoryCommand = Object.freeze({
  kind: 'history',
  direction: 'redo',
  name: 'redo',
  description: 'Re-applies the most recently undone change. Any new change clears what can be redone.',
  input: NoInputSchema,
  tier: 'edit',
  mcp: true,
});

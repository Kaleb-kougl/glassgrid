import type { Draft } from 'immer';
import { z } from 'zod';
import { stateColumns } from '../../crossfilter/axes.js';
import { resolveAxis } from '../../crossfilter/axes.js';
import { defaultChartSpec, MarkError, specForMark } from '../../crossfilter/defaults.js';
import { ChartSpecSchema, MarkSchema, type ChartSpec } from '../../spec/chart.js';
import { FieldSchema, YFieldSchema } from '../../spec/field.js';
import { compileChartQuery } from '../../sql/chart.js';
import { isCompileError } from '../../sql/errors.js';
import { ChartIdSchema, ColumnNameSchema, MAX_CHART_TITLE, type Selection, type WorkspaceState } from '../../state/workspace.js';
import { defineCommand } from '../define.js';
import { CommandError } from '../errors.js';
import { requireChart, requireColumn } from './preconditions.js';

/** Charts one workspace may hold; more would not fit the canvas usefully. */
export const MAX_CHARTS = 64;

const TitleSchema = z.string().trim().min(1).max(MAX_CHART_TITLE);

export const AddChartInputSchema = z.union([
  z.strictObject({
    spec: ChartSpecSchema,
    /** Card title; omit to derive one from the spec. */
    title: TitleSchema.optional(),
  }),
  z.strictObject({
    /**
     * One column, or two dropped together: the chart follows the default
     * chart rules for their types and profile (see `defaultChartSpec`).
     */
    columns: z.array(ColumnNameSchema).min(1).max(2),
    title: TitleSchema.optional(),
  }),
]);
export type AddChartInput = z.input<typeof AddChartInputSchema>;

export const RemoveChartInputSchema = z.strictObject({ chartId: ChartIdSchema });
export type RemoveChartInput = z.input<typeof RemoveChartInputSchema>;

export const RenameChartInputSchema = z.strictObject({
  chartId: ChartIdSchema,
  /** New title; null goes back to the title derived from the spec. */
  title: TitleSchema.nullable(),
});
export type RenameChartInput = z.input<typeof RenameChartInputSchema>;

export const SetMarkInputSchema = z.strictObject({ chartId: ChartIdSchema, mark: MarkSchema });
export type SetMarkInput = z.input<typeof SetMarkInputSchema>;

export const ShelfSchema = z.enum(['x', 'y', 'color']);
export type Shelf = z.infer<typeof ShelfSchema>;

export const SetShelfInputSchema = z.discriminatedUnion('shelf', [
  z.strictObject({ chartId: ChartIdSchema, shelf: z.literal('x'), field: FieldSchema }),
  /** y carries the aggregate (e.g. sum(fare_amount)); null means count(*). */
  z.strictObject({ chartId: ChartIdSchema, shelf: z.literal('y'), field: YFieldSchema.nullable() }),
  z.strictObject({ chartId: ChartIdSchema, shelf: z.literal('color'), field: FieldSchema.nullable() }),
]);
export type SetShelfInput = z.input<typeof SetShelfInputSchema>;

function requireSpecColumns(draft: Draft<WorkspaceState>, spec: ChartSpec, command: string, prefix: string): void {
  requireColumn(draft, spec.x.column, command, `${prefix}x.column`);
  if (spec.y) requireColumn(draft, spec.y.column, command, `${prefix}y.column`);
  if (spec.color) requireColumn(draft, spec.color.column, command, `${prefix}color.column`);
  spec.filters.forEach((filter, i) => requireColumn(draft, filter.column, command, `${prefix}filters[${i}].column`));
}

/** Throws a `precondition_failed` with the compiler's message unless the spec compiles against the workspace's columns. */
function requireValidSpec(draft: Draft<WorkspaceState>, spec: ChartSpec, command: string, path: string): void {
  try {
    compileChartQuery('"t"', spec, stateColumns(draft));
  } catch (error) {
    if (!isCompileError(error)) throw error;
    throw new CommandError('precondition_failed', error.message, {
      command,
      issues: [{ path: error.path === undefined ? path : `${path}.${error.path}`, message: error.message }],
    });
  }
}

/** Whether a selection can still be drawn on (and made by) the chart after its spec changed. */
function selectionFits(spec: ChartSpec, selection: Selection, draft: Draft<WorkspaceState>): boolean {
  const columns = stateColumns(draft);
  return selection.clauses.every((clause) => {
    if (clause.channel === null) return true;
    const axis = resolveAxis(spec, clause.channel, columns);
    if (!axis || axis.column.name !== clause.filter.column) return false;
    const values = clause.filter.kind === 'in' || clause.filter.kind === 'notIn';
    // Clicked bars need a bar chart over raw values; ranges need a positional axis.
    return values ? spec.mark === 'bar' && axis.kind === 'raw' : !(spec.mark === 'bar' && axis.kind === 'raw');
  });
}

/**
 * Adds a chart card, from a full spec or from one or two columns (the
 * default chart rules pick the mark, bins and aggregate). The id comes from
 * the injected generator and is returned in the new state (the last entry of
 * `charts`).
 */
export const addChart = defineCommand({
  name: 'addChart',
  description:
    'Adds a chart card, either from a ChartSpec (mark, x, optional y with its aggregate, optional color) or from { columns: [column] } / { columns: [first, second] }, which picks a default chart from the column types and profile: date → line over time buckets, category ≤ 50 values → bar sorted descending, more → top 20 bars + "Other", number → histogram, number + number → heatmap. The new chart is the last entry of `charts` in the returned state.',
  input: AddChartInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, rawInput, ctx) {
    let input: { spec: ChartSpec; title?: string | undefined };
    if ('columns' in rawInput) {
      rawInput.columns.forEach((column, i) => requireColumn(draft, column, 'addChart', `columns[${i}]`));
      const columns = stateColumns(draft);
      const [first, second] = rawInput.columns.map((name) => columns.find((column) => column.name === name));
      if (first === undefined) throw new CommandError('precondition_failed', 'No column given', { command: 'addChart' });
      const spec = defaultChartSpec(first, second);
      requireValidSpec(draft, spec, 'addChart', 'columns');
      input = { spec, title: rawInput.title };
    } else {
      input = rawInput;
    }
    if (draft.dataSource === null) {
      throw new CommandError('precondition_failed', 'No file is open, so there is nothing to chart', {
        command: 'addChart',
      });
    }
    if (draft.charts.length >= MAX_CHARTS) {
      throw new CommandError('precondition_failed', `A workspace holds at most ${MAX_CHARTS} charts`, {
        command: 'addChart',
      });
    }
    requireSpecColumns(draft, input.spec, 'addChart', 'spec.');
    const id = ctx.newId('chart');
    draft.charts.push({ id, spec: input.spec, ...(input.title === undefined ? {} : { title: input.title }) });
    const y = draft.layout.cards.reduce((bottom, card) => Math.max(bottom, card.y + card.h), 0);
    draft.layout.cards.push({ chartId: id, x: 0, y, w: 1, h: 1 });
  },
});

/** Removes a chart, its card and its selection. */
export const removeChart = defineCommand({
  name: 'removeChart',
  description: 'Removes a chart card together with the selection it applied to the other views.',
  input: RemoveChartInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    requireChart(draft, input.chartId, 'removeChart');
    draft.charts = draft.charts.filter((chart) => chart.id !== input.chartId);
    draft.layout.cards = draft.layout.cards.filter((card) => card.chartId !== input.chartId);
    if (Object.hasOwn(draft.selections, input.chartId)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by validated view ids
      delete draft.selections[input.chartId];
    }
  },
});

export const renameChart = defineCommand({
  name: 'renameChart',
  description: "Sets a chart card's title; null restores the title derived from its spec.",
  input: RenameChartInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    const chart = requireChart(draft, input.chartId, 'renameChart');
    if (input.title === null) delete chart.title;
    else chart.title = input.title;
  },
});

/**
 * Puts a field on one of a chart's shelves. The aggregate lives in the y
 * field (`{ column, aggregate: 'sum' }` reads as sum(column)); clearing y
 * means count(*).
 */
export const setShelf = defineCommand({
  name: 'setShelf',
  description:
    'Sets the x, y or color shelf of a chart. y carries the aggregate, e.g. { column: "fare_amount", aggregate: "sum" }; null on y means count(*), null on color removes the split.',
  input: SetShelfInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    const chart = requireChart(draft, input.chartId, 'setShelf');
    if (input.field !== null) requireColumn(draft, input.field.column, 'setShelf', 'field.column');
    switch (input.shelf) {
      case 'x':
        chart.spec.x = input.field;
        break;
      case 'y':
        if (input.field === null) delete chart.spec.y;
        else chart.spec.y = input.field;
        break;
      case 'color':
        if (input.field === null) delete chart.spec.color;
        else chart.spec.color = input.field;
        break;
    }
  },
});

/**
 * Switches a chart to another mark, re-deriving shelves that the new mark
 * reads differently (see `specForMark`), and checks the result with the
 * compiler. The chart's own selection is cleared when the new mark could not
 * have made it (e.g. clicked bars on a histogram).
 */
export const setMark = defineCommand({
  name: 'setMark',
  description:
    'Changes a chart\'s mark (bar, line, area, histogram, heatmap, scatter). Shelves are re-derived: x stays; y keeps its aggregate on bar/line/area/histogram and becomes the second axis on heatmap/scatter; bins and time units stay where the mark takes them. Fails with the compiler\'s message when the columns cannot make that mark.',
  input: SetMarkInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    const chart = requireChart(draft, input.chartId, 'setMark');
    if (chart.spec.mark === input.mark) return;
    let spec: ChartSpec;
    try {
      spec = specForMark(chart.spec, input.mark, stateColumns(draft));
    } catch (error) {
      if (!(error instanceof MarkError)) throw error;
      throw new CommandError('precondition_failed', error.message, { command: 'setMark', issues: [{ path: error.path, message: error.message }] });
    }
    requireValidSpec(draft, spec, 'setMark', 'mark');
    chart.spec = spec;
    const selection = draft.selections[input.chartId];
    if (selection && !selectionFits(spec, selection, draft)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by validated view ids
      delete draft.selections[input.chartId];
    }
  },
});

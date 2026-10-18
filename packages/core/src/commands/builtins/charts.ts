import type { Draft } from 'immer';
import { z } from 'zod';
import { ChartSpecSchema, type ChartSpec } from '../../spec/chart.js';
import { FieldSchema, YFieldSchema } from '../../spec/field.js';
import { ChartIdSchema, MAX_CHART_TITLE, type WorkspaceState } from '../../state/workspace.js';
import { defineCommand } from '../define.js';
import { CommandError } from '../errors.js';
import { requireChart, requireColumn } from './preconditions.js';

/** Charts one workspace may hold; more would not fit the canvas usefully. */
export const MAX_CHARTS = 64;

const TitleSchema = z.string().trim().min(1).max(MAX_CHART_TITLE);

export const AddChartInputSchema = z.strictObject({
  spec: ChartSpecSchema,
  /** Card title; omit to derive one from the spec. */
  title: TitleSchema.optional(),
});
export type AddChartInput = z.input<typeof AddChartInputSchema>;

export const RemoveChartInputSchema = z.strictObject({ chartId: ChartIdSchema });
export type RemoveChartInput = z.input<typeof RemoveChartInputSchema>;

export const RenameChartInputSchema = z.strictObject({
  chartId: ChartIdSchema,
  /** New title; null goes back to the title derived from the spec. */
  title: TitleSchema.nullable(),
});
export type RenameChartInput = z.input<typeof RenameChartInputSchema>;

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

/**
 * Adds a chart card. The id comes from the injected generator and is
 * returned in the new state (the last entry of `charts`).
 */
export const addChart = defineCommand({
  name: 'addChart',
  description:
    'Adds a chart card from a ChartSpec (mark, x, optional y with its aggregate, optional color). The new chart is the last entry of `charts` in the returned state.',
  input: AddChartInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input, ctx) {
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
    if (Object.hasOwn(draft.filters, input.chartId)) {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- a record keyed by validated view ids
      delete draft.filters[input.chartId];
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

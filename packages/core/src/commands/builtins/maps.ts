import { current, type Draft } from 'immer';
import { z } from 'zod';
import { stateColumns } from '../../crossfilter/axes.js';
import { FilterSchema } from '../../spec/filter.js';
import { MAX_MAP_TRAIL_MINUTES, MapSpecSchema, mapSpecColumns, type MapSpec } from '../../spec/map.js';
import { compileMapLatestQuery } from '../../sql/map.js';
import { isCompileError } from '../../sql/errors.js';
import { roundBounds } from '../../crossfilter/map-selection.js';
import { MapBoundsSchema, MapIdSchema, MAX_CHART_TITLE, MAX_MAP_VIEWS, type MapViewState, type WorkspaceState } from '../../state/workspace.js';
import { defineCommand } from '../define.js';
import { CommandError } from '../errors.js';
import { MCP_EXEMPTIONS } from '../mcp-exemptions.js';
import { requireColumn } from './preconditions.js';

/*
 * Map views (docs/live-flights-l3-data.md): add, update and remove, the map
 * counterparts of addChart, setShelf/renameChart and removeChart. State
 * commands: undoable with Immer patches, tier `edit`, exposed to MCP.
 *
 * L4 (docs/live-flights-l4.md): a map's viewport is its selection, applied
 * to every other view while its "Filter to map view" is on
 * (`setMapViewFilter`, undoable, MCP). The box itself arrives from the map
 * component after every pan or zoom (`setMapViewport`): view state, no undo
 * entry (so panning never floods the history, and Undo never makes the
 * filter disagree with the camera, which it cannot move), and MCP-exempt,
 * since only the map can say what it shows. Removing a map takes its
 * viewport with it.
 */

const TitleSchema = z.string().trim().min(1).max(MAX_CHART_TITLE);

export const AddMapViewInputSchema = z.strictObject({
  /**
   * The map spec; omit it for the flight-point layout (`lat`, `lon`, `hex`,
   * `ts`, a 5-minute trail, no filters).
   */
  spec: MapSpecSchema.optional(),
  /** Card title; omit for "Map". */
  title: TitleSchema.optional(),
  /** Whether the map's viewport filters the other views (default true; see setMapViewFilter). */
  filterToView: z.boolean().optional(),
});
export type AddMapViewInput = z.input<typeof AddMapViewInputSchema>;

export const UpdateMapViewInputSchema = z
  .strictObject({
    mapId: MapIdSchema,
    /** Trail length in whole minutes, 0 to 30 (0: no trails). */
    trailMinutes: z.number().int().min(0).max(MAX_MAP_TRAIL_MINUTES).optional(),
    /** The map's own filters (replacing them); the other views' selections and user filters always apply too. */
    filters: z.array(FilterSchema).optional(),
    lat: z.string().min(1).max(1024).optional(),
    lon: z.string().min(1).max(1024).optional(),
    id: z.string().min(1).max(1024).optional(),
    time: z.string().min(1).max(1024).optional(),
    /** New title; null goes back to "Map". */
    title: TitleSchema.nullable().optional(),
  })
  .refine((input) => Object.keys(input).some((key) => key !== 'mapId'), { message: 'Give at least one field to change' });
export type UpdateMapViewInput = z.input<typeof UpdateMapViewInputSchema>;

export const RemoveMapViewInputSchema = z.strictObject({ mapId: MapIdSchema });
export type RemoveMapViewInput = z.input<typeof RemoveMapViewInputSchema>;

export const SetMapViewportInputSchema = z.strictObject({
  mapId: MapIdSchema,
  /** The box the map shows (degrees), as the map component reports it; rounded outwards to 1e-5°. */
  bounds: MapBoundsSchema,
});
export type SetMapViewportInput = z.input<typeof SetMapViewportInputSchema>;

export const SetMapViewFilterInputSchema = z.strictObject({
  mapId: MapIdSchema,
  /** true: the other views show only what is in the map's view; false: the map filters nothing. */
  enabled: z.boolean(),
});
export type SetMapViewFilterInput = z.input<typeof SetMapViewFilterInputSchema>;

/** Throws a `precondition_failed` listing the map ids unless the map exists; returns it. */
function requireMap(state: Draft<WorkspaceState>, mapId: string, command: string): Draft<MapViewState> {
  const map = state.maps.find((candidate) => candidate.id === mapId);
  if (map !== undefined) return map;
  const known = state.maps.map((candidate) => JSON.stringify(candidate.id));
  throw new CommandError(
    'precondition_failed',
    known.length === 0 ? `Unknown map ${JSON.stringify(mapId)}; there are no map views` : `Unknown map ${JSON.stringify(mapId)}; maps are ${known.join(', ')}`,
    { command, issues: [{ path: 'mapId', message: 'Unknown map' }] },
  );
}

/** Throws a `precondition_failed` with the compiler's message unless the spec compiles against the workspace's columns. */
function requireValidMap(draft: Draft<WorkspaceState>, spec: MapSpec, command: string, prefix: string): void {
  for (const column of mapSpecColumns(spec)) {
    const path = column === spec.lat ? 'lat' : column === spec.lon ? 'lon' : column === spec.id ? 'id' : column === spec.time ? 'time' : 'filters';
    requireColumn(draft, column, command, `${prefix}${path}`);
  }
  try {
    compileMapLatestQuery('"t"', spec, stateColumns(draft), { dataClockMs: 0 });
  } catch (error) {
    if (!isCompileError(error)) throw error;
    throw new CommandError('precondition_failed', error.message, {
      command,
      issues: [{ path: error.path === undefined ? prefix.replace(/\.$/, '') || 'spec' : `${prefix}${error.path}`, message: error.message }],
    });
  }
}

/**
 * Adds a map view card over the open table: its aircraft at their latest
 * fix with trails. The id comes from the injected generator (`map_<n>`) and
 * the map is the last entry of `maps` in the new state.
 */
export const addMapView = defineCommand({
  name: 'addMapView',
  description:
    'Adds a map view of the open table: every aircraft at its latest fix (seen in the 90 s before the data clock) with a trail of its recent fixes. Omit spec for the flight-point layout (lat, lon, hex, ts; 5-minute trails); otherwise { kind: "map", lat, lon, id, time, filters, trailMinutes (0-30) }. The other views\' selections and the user filters apply to it; its own viewport filters the other views unless filterToView is false (see setMapViewFilter). The new map is the last entry of `maps` in the returned state.',
  input: AddMapViewInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input, ctx) {
    if (draft.dataSource === null) {
      throw new CommandError('precondition_failed', 'No file is open, so there is nothing to map', { command: 'addMapView' });
    }
    if (draft.maps.length >= MAX_MAP_VIEWS) {
      throw new CommandError('precondition_failed', `A workspace holds at most ${MAX_MAP_VIEWS} map views`, { command: 'addMapView' });
    }
    const spec = input.spec ?? MapSpecSchema.parse({ kind: 'map' });
    requireValidMap(draft, spec, 'addMapView', 'spec.');
    const id = ctx.newId('map');
    draft.maps.push({ id, spec, ...(input.title === undefined ? {} : { title: input.title }), ...(input.filterToView === false ? { filterToView: false } : {}) });
    const y = draft.layout.cards.reduce((bottom, card) => Math.max(bottom, card.y + card.h), 0);
    draft.layout.cards.push({ chartId: id, x: 0, y, w: 1, h: 1 });
  },
});

/** Changes a map view's trail, own filters, columns or title. */
export const updateMapView = defineCommand({
  name: 'updateMapView',
  description:
    'Changes a map view: trailMinutes (0-30), its own filters (replacing them), the lat / lon / id / time columns, or title (null for the default). Fails with the compiler\'s message when the columns cannot make a map.',
  input: UpdateMapViewInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    const map = requireMap(draft, input.mapId, 'updateMapView');
    const { mapId: _mapId, title, ...changes } = input;
    const defined = Object.fromEntries(Object.entries(changes as Record<string, unknown>).filter(([, value]) => value !== undefined)) as Partial<MapSpec>;
    const spec: MapSpec = { ...current(map).spec, ...defined };
    requireValidMap(draft, spec, 'updateMapView', '');
    map.spec = spec;
    if (title === null) delete map.title;
    else if (title !== undefined) map.title = title;
  },
});

/** Removes a map view and its card. */
export const removeMapView = defineCommand({
  name: 'removeMapView',
  description: 'Removes a map view card.',
  input: RemoveMapViewInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    requireMap(draft, input.mapId, 'removeMapView');
    draft.maps = draft.maps.filter((map) => map.id !== input.mapId);
    draft.layout.cards = draft.layout.cards.filter((card) => card.chartId !== input.mapId);
  },
});

/**
 * Records the box a map shows (its component reports it 200 ms after a pan
 * or zoom ends, and once it has loaded). While the map's "Filter to map
 * view" is on, every other view queries with it. View state: no undo entry,
 * and the redo stack is kept, so panning never floods the history.
 */
export const setMapViewport = defineCommand({
  name: 'setMapViewport',
  description: 'Records the box (west, south, east, north in degrees) a map view shows, as its map reports it after a pan or zoom.',
  input: SetMapViewportInputSchema,
  tier: 'edit',
  mcp: { exempt: MCP_EXEMPTIONS.setMapViewport },
  undoable: false,
  apply(draft, input) {
    const map = requireMap(draft, input.mapId, 'setMapViewport');
    const bounds = roundBounds(input.bounds);
    const before = map.viewport;
    if (before && before.west === bounds.west && before.south === bounds.south && before.east === bounds.east && before.north === bounds.north) return;
    map.viewport = bounds;
  },
});

/**
 * "Filter to map view": whether a map's viewport filters every other view
 * (charts, the grid, other maps). On by default; one undo entry per change.
 */
export const setMapViewFilter = defineCommand({
  name: 'setMapViewFilter',
  description:
    'Turns a map view\'s "Filter to map view" on or off: while on (the default), every other view (charts, the grid, other maps) shows only fixes inside the box the map shows (lat and lon ranges, in state as maps[i].viewport); the map itself is never filtered by its own view.',
  input: SetMapViewFilterInputSchema,
  tier: 'edit',
  mcp: true,
  apply(draft, input) {
    const map = requireMap(draft, input.mapId, 'setMapViewFilter');
    if (input.enabled) delete map.filterToView;
    else map.filterToView = false;
  },
});

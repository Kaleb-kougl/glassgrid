/**
 * Commands the MCP bridge does not expose, each with the reason.
 *
 * A command opts out by declaring `mcp: { exempt: MCP_EXEMPTIONS.<name> }`.
 * This file is the one place a reviewer sees every gap in agent parity; the
 * parity test (`parity.test.ts`) fails if an exempt command is missing here,
 * if its reason differs or is blank, or if an entry here names no registered
 * exempt command.
 */
export const MCP_EXEMPTIONS = Object.freeze({
  openFile:
    'Files are opened only through the native dialog or drag-drop; the input is engine-produced metadata (handle, fingerprint, inferred columns) that an external caller cannot supply truthfully.',
  setColumnProfiles:
    'The input is the engine\'s profile of the open file, recorded by the app when the engine reports it; an external caller cannot supply it truthfully, and agents read profiles through get_state and profile_table.',
  loadWorkspace:
    'The input is a saved workspace restored over data the engine has just opened (handle, fingerprint, inferred columns), which only the app can supply truthfully; agents open workspaces with openWorkspace, from the recent list.',
  setMapViewport:
    'The box a map view shows is reported by its map after the person pans or zooms, and must equal what the map shows; an agent cannot move the camera, so it cannot supply it truthfully. Agents read it from get_state (maps[i].viewport), turn its filter on or off with setMapViewFilter, and filter by area with addFilter on lat and lon.',
  markWorkspaceSaved:
    'Records a save the app itself completed (the document id main issued and the digest of what was written); an external caller cannot know either. Agents save with saveWorkspace.',
} as const satisfies Record<string, string>);

export type McpExemptions = Readonly<Record<string, string>>;

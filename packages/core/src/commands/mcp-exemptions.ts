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
} as const satisfies Record<string, string>);

export type McpExemptions = Readonly<Record<string, string>>;

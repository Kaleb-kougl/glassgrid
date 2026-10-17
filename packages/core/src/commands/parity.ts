import type { AnyCommand } from './define.js';
import type { McpExemptions } from './mcp-exemptions.js';

/**
 * Agent-parity check: every command is either exposed to MCP or exempt with a
 * reason that is also recorded in the exemptions file. Returns one readable
 * problem per violation; an empty array means parity holds.
 */
export function checkMcpParity(commands: Iterable<AnyCommand>, exemptions: McpExemptions): string[] {
  const problems: string[] = [];
  const names = new Set<string>();

  for (const command of commands) {
    names.add(command.name);
    const mcp: unknown = command.mcp;
    if (mcp === true) {
      if (Object.hasOwn(exemptions, command.name)) {
        problems.push(`"${command.name}" is exposed to MCP but listed in the exemptions file; remove the entry`);
      }
      continue;
    }
    if (typeof mcp !== 'object' || mcp === null || !('exempt' in mcp)) {
      problems.push(`"${command.name}" has no mcp declaration; set mcp: true or mcp: { exempt: '<reason>' }`);
      continue;
    }
    const reason = mcp.exempt;
    if (typeof reason !== 'string' || reason.trim() === '') {
      problems.push(`"${command.name}" is exempt from MCP without a reason`);
      continue;
    }
    const listed = Object.hasOwn(exemptions, command.name) ? exemptions[command.name] : undefined;
    if (listed === undefined) {
      problems.push(`"${command.name}" is exempt from MCP but missing from the exemptions file`);
    } else if (listed !== reason) {
      problems.push(`"${command.name}" has a different exemption reason in its definition and the exemptions file`);
    }
  }

  for (const name of Object.keys(exemptions)) {
    if (!names.has(name)) {
      problems.push(`The exemptions file lists "${name}", which is not a registered command`);
    }
  }
  return problems;
}

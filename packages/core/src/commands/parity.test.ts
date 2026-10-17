import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ALL_COMMANDS } from './all.js';
import { type AnyCommand, defineCommand } from './define.js';
import { MCP_EXEMPTIONS } from './mcp-exemptions.js';
import { checkMcpParity } from './parity.js';
import { testWorkspace } from './test-support.js';

describe('agent parity', () => {
  it('every registered command is exposed to MCP or exempt with a recorded reason', () => {
    const { registry } = testWorkspace();
    expect(registry.definitions()).toEqual(ALL_COMMANDS);
    expect(checkMcpParity(registry.definitions(), MCP_EXEMPTIONS)).toEqual([]);
  });

  describe('checkMcpParity', () => {
    const command = (name: string, mcp: unknown): AnyCommand =>
      defineCommand({
        name,
        description: 'test',
        input: z.strictObject({}),
        tier: 'edit',
        mcp: mcp as true,
        apply: () => undefined,
      });

    it('flags a command without an mcp declaration', () => {
      expect(checkMcpParity([command('a', undefined)], {})).toEqual([
        `"a" has no mcp declaration; set mcp: true or mcp: { exempt: '<reason>' }`,
      ]);
    });

    it('flags an exemption without a reason', () => {
      expect(checkMcpParity([command('a', { exempt: '' })], { a: '' })).toEqual([
        '"a" is exempt from MCP without a reason',
      ]);
    });

    it('flags exemptions missing from, or differing from, the exemptions file', () => {
      expect(checkMcpParity([command('a', { exempt: 'why' }), command('b', { exempt: 'why' })], { b: 'other' })).toEqual(
        [
          '"a" is exempt from MCP but missing from the exemptions file',
          '"b" has a different exemption reason in its definition and the exemptions file',
        ],
      );
    });

    it('flags stale or contradictory entries in the exemptions file', () => {
      expect(checkMcpParity([command('a', true)], { a: 'why', gone: 'why' })).toEqual([
        '"a" is exposed to MCP but listed in the exemptions file; remove the entry',
        'The exemptions file lists "gone", which is not a registered command',
      ]);
    });
  });
});

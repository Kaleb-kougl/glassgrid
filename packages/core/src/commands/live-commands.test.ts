import { describe, expect, it, vi } from 'vitest';
import { liveSourceConfigFromInput, LiveSourceInputSchema } from './builtins/live.js';
import { desktopLikePolicy, testWorkspace } from './test-support.js';

/*
 * startLive / stopLive / setLiveSource (docs/live-flights-l2.md): effect
 * commands the app provides over the engine's live feed. They validate their
 * input like any command, record no undo entry and answer `unavailable`
 * until a host provides them. startLive and setLiveSource can empty
 * flight_states (no undo), so they are `write` tier: an AI caller needs the
 * host's confirmation. stopLive is `edit`. All are exposed to MCP.
 */

const user = { caller: 'user' as const };
const ai = { caller: 'ai' as const };

describe('live commands', () => {
  it('are effect commands exposed to MCP (write tier for the two that can empty the table), with a source union as input schema', () => {
    const { registry } = testWorkspace();
    const list = registry.list();
    expect(list.find((info) => info.name === 'startLive')).toMatchObject({ tier: 'write', mcp: { exposed: true } });
    expect(list.find((info) => info.name === 'setLiveSource')).toMatchObject({ tier: 'write', mcp: { exposed: true } });
    expect(list.find((info) => info.name === 'stopLive')).toMatchObject({ tier: 'edit', mcp: { exposed: true } });
    const start = list.find((info) => info.name === 'startLive');
    const variants = (start?.inputSchema as { oneOf?: unknown[]; anyOf?: unknown[] }).oneOf ?? (start?.inputSchema as { anyOf?: unknown[] }).anyOf;
    // live, replay, and (L4) archive: a whole fixture loaded at once for the time cursor.
    expect(variants).toHaveLength(3);
    expect(JSON.stringify(start?.inputSchema)).toContain('flights-bay-30min');
    expect(JSON.stringify(start?.inputSchema)).toContain('"archive"');
  });

  it('answer unavailable until the app provides them', async () => {
    const { registry } = testWorkspace(desktopLikePolicy);
    await expect(registry.dispatch('startLive', { source: 'live' }, user)).rejects.toMatchObject({ code: 'unavailable' });
    await expect(registry.dispatch('stopLive', {}, user)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('starting or switching needs a confirmed write; stopping always runs', async () => {
    const { registry } = testWorkspace(desktopLikePolicy);
    const handler = vi.fn(() => null);
    for (const name of ['startLive', 'stopLive', 'setLiveSource']) registry.provide(name, handler);
    // An agent cannot empty flight_states or start polling on its own (the host's confirmWrite refuses here)...
    await expect(registry.dispatch('startLive', { source: 'live' }, ai)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(registry.dispatch('setLiveSource', { source: 'replay', fixture: 'flights-bay-day' }, ai)).rejects.toMatchObject({ code: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
    // ...but may stop the feed, which keeps every row.
    await registry.dispatch('stopLive', {}, ai);
    await registry.dispatch('startLive', { source: 'live' }, user);
    expect(handler).toHaveBeenCalledTimes(2);
    // Without a confirmWrite hook the tier is refused for everyone.
    const bare = testWorkspace();
    bare.registry.provide('startLive', handler);
    await expect(bare.registry.dispatch('startLive', { source: 'live' }, user)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('pass validated input to the handler, record nothing and return its value', async () => {
    const { registry, store } = testWorkspace({ confirmWrite: () => true });
    const handler = vi.fn((input: unknown) => ({ started: input }));
    registry.provide('startLive', handler);
    const before = store.getState();
    const history = store.getHistory();
    const result = await registry.dispatch('startLive', { source: 'replay', fixture: 'flights-bay-30min', speed: 10 }, ai);
    expect(handler).toHaveBeenCalledWith({ source: 'replay', fixture: 'flights-bay-30min', speed: 10 }, expect.objectContaining({ caller: 'ai' }));
    expect(result).toMatchObject({ entryId: null, value: { started: { source: 'replay' } } });
    expect(store.getState()).toBe(before);
    expect(store.getHistory()).toBe(history);
    // Undo has nothing to step back through: the feed is not workspace state.
    expect((await registry.dispatch('undo', {}, user)).entryId).toBeNull();
  });

  it('refuse invalid sources before the handler runs', async () => {
    const { registry } = testWorkspace({ confirmWrite: () => true });
    const handler = vi.fn(() => null);
    registry.provide('startLive', handler);
    registry.provide('setLiveSource', handler);
    const bad = [
      { source: 'live', intervalSeconds: 5 }, // faster than the CDN's 10 s window
      { source: 'replay' }, // no fixture
      { source: 'replay', fixture: 'flights-bay-week' },
      { source: 'replay', fixture: 'flights-bay-day', speed: 500 },
      { source: 'live', url: 'https://example.com/' }, // no URL from callers
      { source: 'satellite' },
    ];
    for (const input of bad) {
      await expect(registry.dispatch('startLive', input, user), JSON.stringify(input)).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(registry.dispatch('setLiveSource', input, ai), JSON.stringify(input)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('liveSourceConfigFromInput', () => {
  it('maps seconds and minutes to the protocol config', () => {
    const parse = (input: unknown) => liveSourceConfigFromInput(LiveSourceInputSchema.parse(input));
    expect(parse({ source: 'live' })).toEqual({ kind: 'live' });
    expect(parse({ source: 'live', intervalSeconds: 30, retentionMinutes: 15 })).toEqual({ kind: 'live', intervalMs: 30_000, retentionMs: 900_000 });
    expect(parse({ source: 'replay', fixture: 'flights-bay-day', intervalSeconds: 1, speed: 60, retentionMinutes: null })).toEqual({
      kind: 'replay',
      fixture: 'flights-bay-day',
      intervalMs: 1_000,
      speed: 60,
      retentionMs: null,
    });
  });
});

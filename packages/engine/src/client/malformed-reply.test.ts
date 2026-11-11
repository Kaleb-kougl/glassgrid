import { describe, expect, it, vi } from 'vitest';
import { INITIAL_LIVE_STATE } from '@glassgrid/core';
import { PortEngineClient, type EnginePort } from './port-client';

/*
 * A reply the client cannot validate still settles the request it answers:
 * it rejects with `bad_response` instead of leaving the caller waiting
 * forever (an MCP command over the live feed hung this way when a
 * fractional replay clock made the engine's `liveState` reply fail
 * LiveStateSchema).
 */

function portAnswering(reply: (request: { requestId: string; kind: string }) => unknown): EnginePort {
  const port: EnginePort = {
    onmessage: null,
    postMessage(message: unknown) {
      const request = message as { requestId: string; kind: string };
      setTimeout(() => port.onmessage?.({ data: reply(request) } as MessageEvent), 0);
    },
  };
  return port;
}

describe('PortEngineClient and malformed replies', () => {
  it('rejects the request a malformed reply answers, and keeps working', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let malformed = true;
    const client = new PortEngineClient();
    client.adoptPort(
      portAnswering((request) => ({
        kind: 'liveState',
        requestId: request.requestId,
        state: malformed ? { ...INITIAL_LIVE_STATE, source: { kind: 'live' }, lastBatch: { received: 1, inserted: 1, expired: 0, dataClockMs: 1.5 } } : INITIAL_LIVE_STATE,
      })),
    );
    await expect(client.live.state()).rejects.toMatchObject({ code: 'bad_response', message: expect.stringContaining('lastBatch.dataClockMs') as unknown });
    malformed = false;
    await expect(client.live.state()).resolves.toEqual(INITIAL_LIVE_STATE);
    client.dispose();
    vi.restoreAllMocks();
  });
});

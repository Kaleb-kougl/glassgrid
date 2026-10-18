import { MessageChannel, type MessagePort as NodeMessagePort } from 'node:worker_threads';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EngineSession } from '../session';
import { DRIVER_NAME, createHarness, type Harness } from '../test-support';
import { fixtureCsv } from '../testing/fixture';
import { runScenario } from '../testing/scenario';
import { PortEngineClient, type EnginePort } from './port-client';

/*
 * The shared engine scenario (testing/scenario.ts) through PortEngineClient
 * and an EngineSession over a MessageChannel: the same request path the
 * desktop app and the web worker use, minus Electron and the browser. The
 * browser test (e2e/engine-worker.spec.ts) runs the identical scenario in a
 * real Web Worker on DuckDB-WASM.
 */

const ROWS = 20_000;
let h: Harness;
let client: PortEngineClient;
let enginePort: NodeMessagePort;

beforeAll(async () => {
  h = await createHarness();
  const { port1, port2 } = new MessageChannel();
  enginePort = port1;
  const session = new EngineSession(Promise.resolve(h.service), (message) => port1.postMessage(message));
  port1.on('message', (data: unknown) => session.handle(data));
  client = new PortEngineClient();
  client.adoptPort(port2 as unknown as EnginePort);
});

afterAll(async () => {
  client.dispose();
  enginePort.close();
  await h.dispose();
});

describe(`PortEngineClient over a MessageChannel (${DRIVER_NAME})`, () => {
  it('runs the shared engine scenario', { timeout: 120_000 }, async () => {
    const path = join(h.dir, 'scenario.csv');
    await writeFile(path, fixtureCsv(ROWS));
    const { file } = h.register(path);
    const steps = await runScenario(client, file, ROWS);
    expect(steps.map((step) => step.name)).toContain('cross-filter: cube answers equal plain answers');
  });
});

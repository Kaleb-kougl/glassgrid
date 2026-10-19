import { describe, expect, it } from 'vitest';
import { toFileHandle, tableIdForFile } from '@glassgrid/core';
import { createWorkerEngine } from './worker-engine';

/*
 * The worker client's start-up policy, with a fake Worker (no DuckDB): a
 * lazy engine creates no worker until something needs it, so the web demo's
 * start screen downloads no WebAssembly.
 */

class FakeWorker {
  readonly posted: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  kinds(): string[] {
    return this.posted.map((message) => (message as { kind: string }).kind);
  }
}

function lazyEngine() {
  const workers: FakeWorker[] = [];
  const engine = createWorkerEngine({
    start: 'lazy',
    bundles: { eh: '/eh.wasm', mvp: '/mvp.wasm' },
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  return { engine, workers };
}

describe('createWorkerEngine start policy', () => {
  it('eager (the default) starts the worker at once', () => {
    let created = 0;
    const engine = createWorkerEngine({
      bundles: { eh: '/eh.wasm', mvp: '/mvp.wasm' },
      createWorker: () => {
        created += 1;
        return new FakeWorker() as unknown as Worker;
      },
    });
    expect(created).toBe(1);
    expect(engine.started).toBe(true);
    engine.terminate();
  });

  it('lazy waits; subscribing to events does not start it, start() does (once)', () => {
    const { engine, workers } = lazyEngine();
    const off = engine.onEvent(() => undefined);
    const offRestart = engine.onRestarted(() => undefined);
    expect(workers).toHaveLength(0);
    expect(engine.started).toBe(false);
    engine.start();
    engine.start();
    expect(workers).toHaveLength(1);
    expect(workers[0]?.kinds()).toEqual(['gg:init']);
    off();
    offRestart();
    engine.terminate();
  });

  it('lazy starts on the first request and then sends it', async () => {
    const { engine, workers } = lazyEngine();
    const pending = engine.count(tableIdForFile(toFileHandle(crypto.randomUUID())));
    pending.catch(() => undefined);
    expect(workers).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(workers[0]?.kinds()).toEqual(['gg:init', 'count']);
    engine.terminate();
    await expect(pending).rejects.toMatchObject({ code: 'disposed' });
  });

  it('lazy starts on a registration', () => {
    const { engine, workers } = lazyEngine();
    void engine.registerFile(new File(['a,b\n1,2\n'], 'a.csv')).catch(() => undefined);
    expect(workers).toHaveLength(1);
    expect(workers[0]?.kinds()).toEqual(['gg:init', 'gg:registerSource']);
    engine.terminate();
  });

  it('a terminated lazy engine never starts', () => {
    const { engine, workers } = lazyEngine();
    engine.terminate();
    engine.start();
    expect(workers).toHaveLength(0);
  });
});

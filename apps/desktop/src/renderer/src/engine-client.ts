import { tableFromIPC, type Table } from 'apache-arrow';
import {
  ENGINE_PORT_WINDOW_MESSAGE,
  EngineResponseSchema,
  ROW_COUNT_COLUMN,
  type EngineRequest,
  type FileHandle,
  type GlassgridBridge,
} from '@glassgrid/core';

export class EngineRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'EngineRequestError';
  }
}

export interface CountRowsResult {
  rowCount: bigint;
  /** Time spent inside the engine, as reported by the engine. */
  engineMs: number;
}

interface Pending {
  resolve: (table: { table: Table; engineMs: number }) => void;
  reject: (error: Error) => void;
}

/**
 * Talks to the engine utility process over a MessagePort that main brokers
 * directly between the two; this traffic never passes through main.
 *
 * Main may hand over a new port at any time (e.g. after an engine restart).
 * In-flight requests on the old port are then rejected.
 */
export class EngineClient {
  private port: MessagePort | null = null;
  private nextId = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly waiters: Array<(port: MessagePort) => void> = [];

  constructor(private readonly bridge: GlassgridBridge) {
    window.addEventListener('message', this.onWindowMessage);
    this.bridge.requestEnginePort();
  }

  get connected(): boolean {
    return this.port !== null;
  }

  async countRows(handle: FileHandle): Promise<CountRowsResult> {
    const { table, engineMs } = await this.request({ kind: 'countRows', requestId: this.newId(), handle });
    const value: unknown = table.getChild(ROW_COUNT_COLUMN)?.get(0);
    if (typeof value !== 'bigint') {
      throw new EngineRequestError('bad_response', `Expected a BIGINT ${ROW_COUNT_COLUMN} column`);
    }
    return { rowCount: value, engineMs };
  }

  dispose(): void {
    window.removeEventListener('message', this.onWindowMessage);
    this.port?.close();
    this.port = null;
    this.rejectAll(new EngineRequestError('disposed', 'Engine client disposed'));
  }

  private readonly onWindowMessage = (event: MessageEvent): void => {
    // Only accept the port the preload posted to this very window.
    if (event.source !== window || event.data !== ENGINE_PORT_WINDOW_MESSAGE) return;
    const [port] = event.ports;
    if (port) this.adoptPort(port);
  };

  private adoptPort(port: MessagePort): void {
    if (this.port) {
      this.port.close();
      this.rejectAll(new EngineRequestError('engine_restarted', 'The engine restarted; please retry'));
    }
    this.port = port;
    port.onmessage = (event: MessageEvent) => this.onResponse(event.data);
    for (const waiter of this.waiters.splice(0)) waiter(port);
  }

  private connectedPort(): Promise<MessagePort> {
    if (this.port) return Promise.resolve(this.port);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private async request(request: EngineRequest): Promise<{ table: Table; engineMs: number }> {
    const port = await this.connectedPort();
    return new Promise((resolve, reject) => {
      this.pending.set(request.requestId, { resolve, reject });
      port.postMessage(request);
    });
  }

  private onResponse(raw: unknown): void {
    const parsed = EngineResponseSchema.safeParse(raw);
    if (!parsed.success) {
      console.error('[engine-client] dropped malformed response', parsed.error.issues);
      return;
    }
    const response = parsed.data;
    if (response.requestId === null) {
      console.error('[engine-client] engine rejected an unidentifiable request', response);
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    this.pending.delete(response.requestId);

    if (response.kind === 'error') {
      pending.reject(new EngineRequestError(response.code, response.message));
      return;
    }
    try {
      pending.resolve({ table: tableFromIPC(response.ipc), engineMs: response.engineMs });
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private newId(): string {
    this.nextId += 1;
    return `req-${this.nextId}`;
  }
}

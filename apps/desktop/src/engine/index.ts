/*
 * Glassgrid engine: runs inside an Electron utility process and owns DuckDB.
 *
 * - Control messages (from main) arrive on process.parentPort.
 * - Query requests arrive on MessagePorts that main brokers directly to
 *   renderers; results go back as Arrow IPC bytes on the same port.
 */
import { stat } from 'node:fs/promises';
import { DuckDBInstance, version as duckdbVersion } from '@duckdb/node-api';
import { tableToIPC } from 'apache-arrow';
import type { MessagePortMain } from 'electron';
import {
  ControlMessageSchema,
  EngineRequestSchema,
  Sql,
  type ControlReply,
  type CountRowsRequest,
  type EngineErrorCode,
  type EngineResponse,
  type FileHandle,
  type RegisterFileMessage,
} from '@glassgrid/core';
import { readerToArrowTable } from './arrow';

class EngineFailure extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EngineFailure';
  }
}

const parentPort = process.parentPort;
const sources = new Map<FileHandle, string>();

const instance = DuckDBInstance.create(':memory:', {
  // An offline desktop app must never fetch extensions behind the user's back.
  autoinstall_known_extensions: 'false',
});

function reply(message: ControlReply): void {
  parentPort.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Control plane (main -> engine)

parentPort.on('message', (event) => {
  const parsed = ControlMessageSchema.safeParse(event.data);
  if (!parsed.success) {
    console.error('[engine] dropped malformed control message', parsed.error.issues);
    return;
  }
  const message = parsed.data;

  switch (message.kind) {
    case 'attachPort': {
      const [port] = event.ports;
      if (port) attachPort(port);
      return;
    }
    case 'registerFile':
      void registerFile(message).then(reply);
      return;
  }
});

async function registerFile({ requestId, handle, path }: RegisterFileMessage): Promise<ControlReply> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return { kind: 'registerFailed', requestId, message: 'Not a regular file' };
    sources.set(handle, path);
    return { kind: 'fileRegistered', requestId, handle, sizeBytes: info.size };
  } catch (error) {
    return { kind: 'registerFailed', requestId, message: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Data plane (renderer <-> engine)

function attachPort(port: MessagePortMain): void {
  port.on('message', (event) => {
    void handleRequest(event.data).then((response) => port.postMessage(response));
  });
  port.start();
}

async function handleRequest(raw: unknown): Promise<EngineResponse> {
  const parsed = EngineRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const requestId =
      typeof raw === 'object' && raw !== null && 'requestId' in raw && typeof raw.requestId === 'string'
        ? raw.requestId
        : null;
    return { kind: 'error', requestId, code: 'bad_request', message: parsed.error.message };
  }

  const request = parsed.data;
  try {
    // M0 has a single request kind; dispatch on `request.kind` once there are more.
    return await countRows(request);
  } catch (error) {
    const code = error instanceof EngineFailure ? error.code : 'query_failed';
    return { kind: 'error', requestId: request.requestId, code, message: errorMessage(error) };
  }
}

async function countRows(request: CountRowsRequest): Promise<EngineResponse> {
  const path = sources.get(request.handle);
  if (!path) throw new EngineFailure('unknown_handle', 'This file is no longer open');

  let db: DuckDBInstance;
  try {
    db = await instance;
  } catch (error) {
    throw new EngineFailure('engine_unavailable', `DuckDB failed to start: ${errorMessage(error)}`);
  }

  const started = performance.now();
  // One connection per request lets independent requests run concurrently.
  const connection = await db.connect();
  try {
    const reader = await connection.runAndReadAll(Sql.countRows, [path]);
    const ipc = tableToIPC(readerToArrowTable(reader), 'stream');
    return { kind: 'arrow', requestId: request.requestId, ipc, engineMs: performance.now() - started };
  } finally {
    connection.closeSync();
  }
}

// ---------------------------------------------------------------------------
// Lifecycle

instance.then(
  () => reply({ kind: 'ready', duckdbVersion: duckdbVersion() }),
  (error: unknown) => reply({ kind: 'fatal', message: `DuckDB failed to start: ${errorMessage(error)}` }),
);

process.on('uncaughtException', (error) => {
  reply({ kind: 'fatal', message: errorMessage(error) });
  process.exit(1);
});

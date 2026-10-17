/*
 * Glassgrid engine: runs inside an Electron utility process and owns DuckDB.
 *
 * - Control messages (from main) arrive on process.parentPort.
 * - Query requests arrive on MessagePorts that main brokers directly to
 *   renderers; each port gets an EngineSession. Results go back as Arrow IPC
 *   bytes (pages) or small JSON objects (profiles, counts) on the same port.
 */
import { stat } from 'node:fs/promises';
import { version as duckdbVersion } from '@duckdb/node-api';
import type { MessagePortMain } from 'electron';
import {
  ControlMessageSchema,
  ENGINE_CONFIG_ARG,
  EngineConfigSchema,
  type ControlReply,
  type EngineConfig,
  type RegisterFileMessage,
} from '@glassgrid/core';
import { errorMessage } from './errors';
import { QueryService } from './query-service';
import { EngineSession } from './session';

const parentPort = process.parentPort;

function reply(message: ControlReply): void {
  parentPort.postMessage(message);
}

function readConfig(): EngineConfig {
  const index = process.argv.indexOf(ENGINE_CONFIG_ARG);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  if (raw === undefined) throw new Error(`Missing ${ENGINE_CONFIG_ARG} argument`);
  return EngineConfigSchema.parse(JSON.parse(raw));
}

const service: Promise<QueryService> = (async () => QueryService.create(readConfig()))();
// Failures are reported through the 'fatal' reply below and per request as engine_unavailable.
service.catch(() => undefined);

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
  // Register in a microtask, before any later port message can be handled:
  // after a respawn, main replays registrations right before attaching new
  // ports, and the renderer's re-issued queries must find their files.
  const registered = service.then((ready) => ready.registerFile(handle, path));
  try {
    await registered;
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Not a regular file');
    return { kind: 'fileRegistered', requestId, handle, sizeBytes: info.size };
  } catch (error) {
    await service.then((ready) => ready.unregisterFile(handle)).catch(() => undefined);
    return { kind: 'registerFailed', requestId, message: errorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Data plane (renderer <-> engine)

function attachPort(port: MessagePortMain): void {
  const session = new EngineSession(service, (message) => port.postMessage(message));
  port.on('message', (event) => session.handle(event.data));
  port.on('close', () => session.dispose());
  port.start();
}

// ---------------------------------------------------------------------------
// Lifecycle

service.then(
  () => reply({ kind: 'ready', duckdbVersion: duckdbVersion() }),
  (error: unknown) => reply({ kind: 'fatal', message: `DuckDB failed to start: ${errorMessage(error)}` }),
);

process.on('unhandledRejection', (reason) => {
  // A bug, but not one worth losing every open view over.
  console.error('[engine] unhandled rejection', reason);
});

process.on('uncaughtException', (error) => {
  reply({ kind: 'fatal', message: errorMessage(error) });
  process.exit(1);
});

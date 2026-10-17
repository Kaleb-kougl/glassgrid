import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import {
  MessageChannelMain,
  utilityProcess,
  type MessagePortMain,
  type UtilityProcess,
  type WebContents,
} from 'electron';
import {
  ControlReplySchema,
  IpcChannel,
  toFileHandle,
  type ControlMessage,
  type ControlReply,
  type FileHandle,
} from '@glassgrid/core';

const REGISTER_TIMEOUT_MS = 15_000;
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

interface PendingRegistration {
  resolve: (value: RegisteredFile) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RegisteredFile {
  handle: FileHandle;
  sizeBytes: number;
}

interface EngineHostEvents {
  /** The engine was respawned after a crash; renderers need a new port. */
  restarted: [];
}

/**
 * Owns the DuckDB engine utility process.
 *
 * Main only does control-plane work here: spawning the engine, telling it
 * which handle maps to which file, and brokering MessagePorts. Query traffic
 * flows renderer <-> engine directly and never passes through this class.
 */
export class EngineHost extends EventEmitter<EngineHostEvents> {
  private child: UtilityProcess | null = null;
  private stopping = false;
  private readonly restarts: number[] = [];
  private readonly pending = new Map<string, PendingRegistration>();
  /** handle -> absolute path; replayed into a respawned engine. */
  private readonly sources = new Map<FileHandle, string>();

  constructor(private readonly entryPath = join(__dirname, 'engine.js')) {
    super();
  }

  start(): void {
    if (this.child) return;
    this.stopping = false;

    const child = utilityProcess.fork(this.entryPath, [], {
      serviceName: 'Glassgrid Engine',
      stdio: 'inherit',
    });
    this.child = child;

    child.on('message', (raw: unknown) => this.onReply(raw));
    child.on('exit', (code) => this.onExit(child, code));

    // Re-teach a respawned engine about files the user already opened.
    for (const [handle, path] of this.sources) {
      this.send({ kind: 'registerFile', requestId: randomUUID(), handle, path });
    }
  }

  stop(): void {
    this.stopping = true;
    this.child?.kill();
    this.child = null;
  }

  /** Create a fresh renderer <-> engine channel and hand each side its end. */
  connectRenderer(contents: WebContents): void {
    this.start();
    const { port1, port2 } = new MessageChannelMain();
    this.send({ kind: 'attachPort' }, [port1]);
    contents.postMessage(IpcChannel.enginePort, null, [port2]);
  }

  /** Register a file with the engine and resolve with its opaque handle. */
  registerFile(path: string): Promise<RegisteredFile> {
    this.start();
    const requestId = randomUUID();
    const handle = toFileHandle(randomUUID());

    return new Promise<RegisteredFile>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Timed out waiting for the engine to register the file'));
      }, REGISTER_TIMEOUT_MS);

      this.pending.set(requestId, {
        resolve: (file) => {
          this.sources.set(file.handle, path);
          resolve(file);
        },
        reject,
        timer,
      });
      this.send({ kind: 'registerFile', requestId, handle, path });
    });
  }

  private send(message: ControlMessage, transfer?: MessagePortMain[]): void {
    if (!this.child) throw new Error('Engine is not running');
    this.child.postMessage(message, transfer);
  }

  private onReply(raw: unknown): void {
    const parsed = ControlReplySchema.safeParse(raw);
    if (!parsed.success) {
      console.error('[engine-host] dropped malformed engine reply', parsed.error.issues);
      return;
    }
    const reply: ControlReply = parsed.data;

    switch (reply.kind) {
      case 'ready':
        console.info(`[engine-host] engine ready (DuckDB ${reply.duckdbVersion})`);
        return;
      case 'fatal':
        console.error(`[engine-host] engine reported a fatal error: ${reply.message}`);
        return;
      case 'fileRegistered':
        this.settle(reply.requestId, (p) => p.resolve({ handle: reply.handle, sizeBytes: reply.sizeBytes }));
        return;
      case 'registerFailed':
        this.settle(reply.requestId, (p) => p.reject(new Error(reply.message)));
        return;
    }
  }

  private settle(requestId: string, fn: (pending: PendingRegistration) => void): void {
    const pending = this.pending.get(requestId);
    if (!pending) return; // replayed registration, or already timed out
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    fn(pending);
  }

  private onExit(child: UtilityProcess, code: number): void {
    if (this.child !== child) return;
    this.child = null;

    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Engine exited (code ${code})`));
      this.pending.delete(id);
    }
    if (this.stopping) return;

    const now = Date.now();
    while (this.restarts.length > 0 && now - (this.restarts[0] ?? now) > RESTART_WINDOW_MS) {
      this.restarts.shift();
    }
    if (this.restarts.length >= MAX_RESTARTS) {
      console.error(`[engine-host] engine exited with code ${code}; restart limit reached`);
      return;
    }
    this.restarts.push(now);
    console.warn(`[engine-host] engine exited with code ${code}; restarting`);
    this.start();
    this.emit('restarted');
  }
}

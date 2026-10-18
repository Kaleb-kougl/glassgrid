import { isAbsolute, resolve } from 'node:path';
import { WORKSPACE_FILE_EXTENSION, type ExternalOpenRequest } from '@glassgrid/core';

/*
 * Workspace files the OS hands the app: a double-click or "Open with"
 * (macOS `open-file`; Windows and Linux pass the path in argv, to the first
 * instance at launch and through `second-instance` later). Each becomes a
 * single-use token; the renderer decides when to open it (after asking to
 * save its own work) with `openWorkspace({ source: 'external', token })`.
 */

/** `.glassgrid` paths in a command line (flags and the executable skipped), made absolute against `cwd`. */
export function workspacePathsFromArgv(argv: readonly string[], cwd: string): string[] {
  return argv
    .slice(1)
    .filter((arg) => !arg.startsWith('-') && arg.toLowerCase().endsWith(`.${WORKSPACE_FILE_EXTENSION}`))
    .map((arg) => (isAbsolute(arg) ? arg : resolve(cwd, arg)));
}

export interface OpenRequestTarget {
  readonly key: number;
  send(request: ExternalOpenRequest): void;
}

/**
 * Holds OS open requests until a window listens (its renderer subscribed
 * with `onOpenRequest`), then delivers each to one window.
 */
export class OpenRequestQueue {
  private readonly queued: ExternalOpenRequest[] = [];
  private readonly listeners = new Map<number, OpenRequestTarget>();

  constructor(private readonly preferred: () => number | null = () => null) {}

  push(request: ExternalOpenRequest): void {
    const target = this.target();
    if (target) target.send(request);
    else this.queued.push(request);
  }

  /** A window's renderer is ready for requests: returns (and clears) the queued ones. */
  listen(target: OpenRequestTarget): ExternalOpenRequest[] {
    this.listeners.set(target.key, target);
    return this.queued.splice(0);
  }

  remove(key: number): void {
    this.listeners.delete(key);
  }

  private target(): OpenRequestTarget | undefined {
    const preferred = this.preferred();
    return (preferred === null ? undefined : this.listeners.get(preferred)) ?? this.listeners.values().next().value;
  }
}

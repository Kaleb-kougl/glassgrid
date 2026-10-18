import { EngineFailure, abortCode, raceAbort } from './errors';

interface Shared<T> {
  promise: Promise<T>;
  controller: AbortController;
  waiters: number;
}

/**
 * Runs at most one task per key at a time and lets identical requests share
 * it (e.g. two views, or two windows, asking for the same grid page).
 *
 * Each caller passes its own AbortSignal. Aborting rejects that caller at
 * once; the shared task is aborted (and DuckDB interrupted) only when every
 * caller has aborted. A caller arriving after that starts a fresh task.
 */
export class Coalescer<T> {
  private readonly running = new Map<string, Shared<T>>();
  private joined = 0;

  run(key: string, signal: AbortSignal | undefined, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(new EngineFailure(abortCode(signal), 'Request was cancelled'));
    let shared = this.running.get(key);
    if (shared && !shared.controller.signal.aborted) {
      this.joined += 1;
    } else {
      const controller = new AbortController();
      const created: Shared<T> = { controller, waiters: 0, promise: Promise.resolve() as Promise<T> };
      created.promise = (async () => task(controller.signal))().finally(() => {
        if (this.running.get(key) === created) this.running.delete(key);
      });
      // Callers observe the outcome through raceAbort; keep an abandoned task from being "unhandled".
      created.promise.catch(() => undefined);
      this.running.set(key, created);
      shared = created;
    }

    const current = shared;
    current.waiters += 1;
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      current.waiters -= 1;
      if (current.waiters === 0 && signal?.aborted) {
        current.controller.abort(signal.reason);
        if (this.running.get(key) === current) this.running.delete(key);
      }
    };
    signal?.addEventListener('abort', leave, { once: true });
    return raceAbort(current.promise, signal).finally(() => {
      signal?.removeEventListener('abort', leave);
      leave();
    });
  }

  /** Requests that joined an identical in-flight task instead of starting one. */
  get joinedCount(): number {
    return this.joined;
  }

  get size(): number {
    return this.running.size;
  }
}

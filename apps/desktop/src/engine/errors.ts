import type { EngineErrorCode } from '@glassgrid/core';

/** An expected failure with a protocol error code. Everything else maps to `query_failed`. */
export class EngineFailure extends Error {
  constructor(
    readonly code: EngineErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EngineFailure';
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** DuckDB reports `connection.interrupt()` as "INTERRUPT Error: Interrupted!". */
export function isInterruptError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('INTERRUPT Error');
}

/** Why an AbortSignal fired, as a protocol code. */
export function abortCode(signal: AbortSignal): EngineErrorCode {
  const reason: unknown = signal.reason;
  return reason instanceof EngineFailure ? reason.code : 'cancelled';
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new EngineFailure(abortCode(signal), 'Request was cancelled');
}

/** Map any thrown value to a code and message suitable for the wire. */
export function toEngineFailure(error: unknown, signal?: AbortSignal): EngineFailure {
  if (error instanceof EngineFailure) return error;
  if (signal?.aborted || isInterruptError(error)) {
    return new EngineFailure(signal ? abortCode(signal) : 'cancelled', 'Request was cancelled', { cause: error });
  }
  return new EngineFailure('query_failed', errorMessage(error), { cause: error });
}

/** Resolve with `promise`, or reject as soon as `signal` aborts. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new EngineFailure(abortCode(signal), 'Request was cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

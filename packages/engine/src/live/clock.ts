import type { LiveClock } from '@glassgrid/core';

/** The real clock: `Date.now` and the global timers (faked by Vitest's fake timers in tests). */
export const systemClock: LiveClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom has no canvas backend; components treat a null context as "nothing to draw".
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
}

afterEach(() => {
  cleanup();
});

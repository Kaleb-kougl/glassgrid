import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** Serves the CanvasGrid benchmark page (bench/grid) for run-grid-bench.ts. */
export default defineConfig({
  root: fileURLToPath(new URL('./grid', import.meta.url)),
  plugins: [react()],
  logLevel: 'warn',
  server: { strictPort: false },
});

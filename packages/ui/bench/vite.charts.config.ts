import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/** Serves the chart benchmark page (bench/charts) for run-charts-bench.ts. */
export default defineConfig({
  root: fileURLToPath(new URL('./charts', import.meta.url)),
  plugins: [react()],
  logLevel: 'warn',
  server: { strictPort: false },
});

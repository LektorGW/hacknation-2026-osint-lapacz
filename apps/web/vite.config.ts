import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Z @olcys/core importujemy wyłącznie typy — alias służy tylko rozwiązywaniu ścieżek.
    alias: {
      '@olcys/core': fileURLToPath(new URL('../../packages/core/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://localhost:4000' },
  },
});

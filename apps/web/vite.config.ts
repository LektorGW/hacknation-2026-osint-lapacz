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
    // Port serwera deweloperskiego i port API można zmienić zmiennymi (np. przez `pnpm dev` z pliku .env).
    port: Number(process.env.VITE_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 4000}` },
  },
});

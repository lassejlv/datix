import { defineConfig } from 'vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
  build: { outDir: 'dist/client', emptyOutDir: true },
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${process.env.DEV_API_PORT ?? 3001}`,
      '/health': `http://127.0.0.1:${process.env.DEV_API_PORT ?? 3001}`,
    },
  },
});

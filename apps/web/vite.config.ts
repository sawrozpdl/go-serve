import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.WEB_PORT ?? 5891),
    strictPort: true,
    proxy: {
      '/v1': {
        target: process.env.VITE_API_URL ?? 'http://localhost:9090',
        changeOrigin: true,
      },
      '/auth': {
        target: process.env.VITE_API_URL ?? 'http://localhost:9090',
        changeOrigin: true,
      },
      '/ws': {
        target: process.env.VITE_API_URL ?? 'http://localhost:9090',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});

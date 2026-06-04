import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Bake SemVer (from package.json) + short git SHA into the bundle so the
// sidebar can show "v1.1.0 · abc1234" at runtime. SHA is best-effort —
// builds outside a git checkout just omit it.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')) as { version: string };
let gitSha = '';
try {
  gitSha = execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
} catch {
  /* not a git checkout — leave empty */
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_GIT_SHA__: JSON.stringify(gitSha),
    __APP_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
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
      '/public': {
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

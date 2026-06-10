import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
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
  plugins: [
    react(),
    // Installable PWA + offline app shell. The service worker precaches the
    // built assets only — API data is NEVER cached here (offline reads come
    // from the persisted TanStack Query cache in main.tsx, which knows about
    // auth and tenancy; a SW HTTP cache doesn't).
    VitePWA({
      // Never auto-reload a POS mid-order: surface an "update available"
      // prompt (components/UpdatePrompt.tsx) and let the cashier choose.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: 'GoServe POS',
        short_name: 'GoServe',
        description: 'Cafe point-of-sale and management',
        display: 'standalone',
        start_url: '/admin/floor',
        background_color: '#08070a',
        theme_color: '#08070a',
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // SPA routes resolve offline; API + websocket paths must never be
        // swallowed by the navigation fallback.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/v1\//, /^\/auth\//, /^\/public\//, /^\/ws/, /^\/uploads\//],
        // Google Fonts: stylesheet revalidates in the background, font files
        // are immutable — cache-first for a year so offline launch keeps the
        // brand typography instead of falling back to system fonts.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\//,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-styles' },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-files',
              expiration: { maxEntries: 24, maxAgeSeconds: 365 * 24 * 60 * 60 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
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

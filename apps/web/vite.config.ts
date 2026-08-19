/// <reference types="vitest/config" />
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

// Vite's MPA dev server serves /play.html for the literal path only, but the
// printed QR points at /play/{slug}. Without this the play page is unreachable
// in dev, slug parsing goes unexercised, and the mismatch only surfaces after a
// deploy. Mirrors the vercel.json rewrite.
function playDevRewrite() {
  return {
    name: 'play-dev-rewrite',
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => void } }) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/play\/[^?]*/.test(req.url) && !req.url.startsWith('/play.html')) {
          req.url = '/play.html';
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    playDevRewrite(),
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
        // /play/ is in this list for a reason that only reproduces on a device
        // which has ALREADY installed the POS PWA: without it, a staff tablet
        // visiting a play link gets the admin shell served from cache instead of
        // the guest page. It will never show up in dev, and it will show up on
        // the owner's tablet.
        navigateFallbackDenylist: [/^\/v1\//, /^\/auth\//, /^\/public\//, /^\/ws/, /^\/uploads\//, /^\/play\//],
        // The guest entry is deliberately kept out of the staff service worker:
        // precaching it would put a second React bundle on every POS device for
        // a page staff never open.
        globIgnores: ['**/play*.{js,css}'],
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
    rollupOptions: {
      // TWO entries, deliberately. The guest play page must not share an entry
      // graph with the admin app: index.js is ~1.1MB and index.css ~264KB
      // because main.tsx pulls admin.css and the query persister, and App.tsx
      // statically imports ~40 admin pages (and through them lib/api.ts, the
      // auth store and ~100 lucide icons). A lazy ROUTE cannot avoid any of
      // that — /menu/:slug is already lazy and still pays it — because the cost
      // is in the entry, not the route.
      //
      // Guarding this: eslint's no-restricted-imports block for src/play/**,
      // and an e2e assertion that /play never requests index-*.js.
      input: {
        main: path.resolve(__dirname, 'index.html'),
        play: path.resolve(__dirname, 'play.html'),
      },
    },
  },
  // Vitest owns the unit tests under src/ (*.test.ts). Playwright e2e specs
  // live in e2e/ as *.spec.ts and must NOT be collected here — Vitest's
  // default include glob matches *.spec.* too, so scope it to src/ explicitly.
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
  },
});

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { get as idbGet, set as idbSet, del as idbDel } from 'idb-keyval';
import { BrowserRouter } from 'react-router-dom';

import '@cafe-mgmt/design-tokens/tokens.css';
import './styles/global.css';
import './styles/admin.css';

import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ConfirmProvider } from './components/ConfirmDialog';
import { initTheme } from './lib/theme';

initTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
      // Long gcTime so successful data survives in the cache to be persisted —
      // the default 5min would garbage-collect everything between visits and
      // leave nothing to restore on an offline launch.
      gcTime: 24 * 60 * 60 * 1000,
    },
  },
});

// Offline read path: the query cache is persisted to IndexedDB and restored
// before first render, so a POS tablet that loses wifi (or relaunches without
// it) still shows the last-known floor, menu, and open tabs.
const persister = createAsyncStoragePersister({
  storage: {
    getItem: (key: string) => idbGet<string>(key).then((v) => v ?? null),
    setItem: (key: string, value: string) => idbSet(key, value),
    removeItem: (key: string) => idbDel(key),
  },
  key: 'cafe-query-cache',
});

// Allowlist of persisted query families. Deliberately narrow: operational
// data a cashier needs offline. Staff personal records, finance/reports, and
// audit data stay OUT of browser storage.
const PERSIST_KEYS = new Set([
  'me',
  'tenant-settings',
  'menu-categories',
  'menu-items',
  'menu-popular',
  'tables',
  'orders',
  'order',
  'order-adjustments',
  'order-quote',
  'kitchen-tickets',
]);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');

createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{
          persister,
          maxAge: 24 * 60 * 60 * 1000,
          // A new build drops the persisted cache — response shapes may have
          // changed, and stale-bundle vs fresh-data mismatches are subtle.
          buster: `${__APP_VERSION__}:${__APP_GIT_SHA__}`,
          dehydrateOptions: {
            shouldDehydrateQuery: (q) =>
              q.state.status === 'success' && PERSIST_KEYS.has(String(q.queryKey[0])),
          },
        }}
      >
        <BrowserRouter>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
        </BrowserRouter>
      </PersistQueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

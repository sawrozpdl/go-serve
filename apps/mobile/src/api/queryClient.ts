/**
 * Shared TanStack Query client. Defaults tuned for a POS: reads stay fresh for
 * 30s, cache is retained long so persisted/rehydrated data survives offline
 * (M5 adds the MMKV persister on top of this same client).
 */
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 24 * 60 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

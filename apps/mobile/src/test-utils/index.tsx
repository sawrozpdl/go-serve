/**
 * Shared test helpers: a providers wrapper for rendering screens, and a small
 * URL-routing fetch mock so tests script API responses by path.
 */
import type { ReactElement } from 'react';
import { render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@/theme';

const metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

export function renderWithProviders(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <SafeAreaProvider initialMetrics={metrics}>
      <QueryClientProvider client={client}>
        <ThemeProvider initialPreference="dark">{ui}</ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}

type Handler = (body: unknown) => { status?: number; json?: unknown };

/** Install a fetch mock that routes by URL substring. Returns the jest spy. */
export function mockFetchByPath(routes: Record<string, Handler>) {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const out = key ? routes[key](body) : { status: 404, json: {} };
    const status = out.status ?? 200;
    return {
      status,
      ok: status >= 200 && status < 300,
      statusText: '',
      json: async () => out.json ?? {},
    } as unknown as Response;
  });
}

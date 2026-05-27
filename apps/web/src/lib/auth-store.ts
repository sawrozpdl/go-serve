// JWT auth token store, persisted to localStorage.
//
// The API and SPA are cross-site (different registrable domains), so a session
// cookie would be a third-party cookie — silently blocked by iOS WebKit (ITP).
// We therefore hold the tokens client-side and send the access token as an
// `Authorization: Bearer` header.
//
//   - access token  — short-lived (~15m) JWT; sent on every request.
//   - refresh token  — long-lived, opaque, rotated on use; used to mint a new
//     access token when the current one 401s.
//
// Both live in localStorage so a page reload survives without an immediate
// refresh round-trip. Memory-only access tokens buy little here: the refresh
// token must persist in localStorage regardless, and an XSS attacker who can
// read it would just call /auth/refresh anyway.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type AuthState = {
  accessToken: string | null;
  refreshToken: string | null;
  setTokens: (access: string, refresh: string) => void;
  clear: () => void;
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      clear: () => set({ accessToken: null, refreshToken: null }),
    }),
    { name: 'cafe-auth' },
  ),
);

// Non-React accessors for the fetch layer (lib/api.ts), which runs outside the
// component tree.
export const getAccessToken = (): string | null => useAuthStore.getState().accessToken;
export const getRefreshToken = (): string | null => useAuthStore.getState().refreshToken;
export const setTokens = (access: string, refresh: string): void =>
  useAuthStore.getState().setTokens(access, refresh);
export const clearTokens = (): void => useAuthStore.getState().clear();

/** React hook: true when a refresh token is present (i.e. a session exists). */
export function useIsAuthed(): boolean {
  return useAuthStore((s) => s.refreshToken !== null);
}

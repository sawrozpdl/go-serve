/**
 * Reactive auth flag. The token *values* live in the secure tokenStore; this
 * store only mirrors "is there a session?" for the navigation guards, plus a
 * `hydrated` gate so the router waits for tokenStore.hydrate() before deciding
 * where to send the user (avoids a login-screen flash on cold start).
 */
import { create } from 'zustand';
import { hydrate as hydrateTokens, hasSession, clearTokens } from '../auth/tokenStore';
import { useTenantStore } from './tenant';

type AuthState = {
  hydrated: boolean;
  hasSession: boolean;
  /** Read tokens from secure storage once at cold start. */
  hydrate: () => Promise<void>;
  /** Call after a successful login/exchange (tokens already persisted). */
  onAuthenticated: () => void;
  /** Local sign-out: wipe tokens + active tenant, flip the guard. */
  signOut: () => Promise<void>;
};

export const useAuthStore = create<AuthState>((set) => ({
  hydrated: false,
  hasSession: false,
  hydrate: async () => {
    await hydrateTokens();
    set({ hydrated: true, hasSession: hasSession() });
  },
  onAuthenticated: () => set({ hasSession: true }),
  signOut: async () => {
    await clearTokens();
    useTenantStore.getState().clear();
    set({ hasSession: false });
  },
}));

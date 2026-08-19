/**
 * Reactive auth flag. The token *values* live in the secure tokenStore; this
 * store only mirrors "is there a session?" for the navigation guards, plus a
 * `hydrated` gate so the router waits for tokenStore.hydrate() before deciding
 * where to send the user (avoids a login-screen flash on cold start).
 *
 * Guest ("demo") mode rides on the same two flags: `enterDemo()` sets
 * `hasSession: true` alongside a synthetic active tenant, so every router guard
 * passes unchanged and no screen needs a demo branch. `demo` itself is only read
 * for suppression (realtime, connectivity, offline replay) and labelling.
 */
import { create } from 'zustand';
import { hydrate as hydrateTokens, hasSession, clearTokens } from '../auth/tokenStore';
import { useTenantStore } from './tenant';
import { DEMO_SLUG } from '../demo/constants';

type AuthState = {
  hydrated: boolean;
  hasSession: boolean;
  /** True while the guest demo is running. Never set together with real tokens. */
  demo: boolean;
  /** Read tokens from secure storage once at cold start. */
  hydrate: () => Promise<void>;
  /** Call after a successful login/exchange (tokens already persisted). */
  onAuthenticated: () => void;
  /** Enter guest mode. Callers must set the demo tenant themselves (see
   *  src/demo/session.ts) — this store must not import the demo world. */
  startDemo: () => void;
  /** Local sign-out: wipe tokens + active tenant + demo flag, flip the guard. */
  signOut: () => Promise<void>;
};

export const useAuthStore = create<AuthState>((set, get) => ({
  hydrated: false,
  hasSession: false,
  demo: false,
  hydrate: async () => {
    await hydrateTokens();
    // A guest legitimately has no tokens, so tokenStore.hasSession() is false for
    // one — don't let hydration knock them back out to login mid-session.
    set((s) => ({ hydrated: true, hasSession: s.demo || hasSession() }));
    // Heal state left by a force-quit mid-demo: tenant.ts persists `active` to
    // MMKV, so without this the next cold start boots into the app shell sending
    // X-Tenant-ID: demo on real requests and 403s everywhere.
    const tenant = useTenantStore.getState();
    if (!get().demo && tenant.active?.slug === DEMO_SLUG) tenant.clear();
  },
  onAuthenticated: () => set({ hasSession: true }),
  startDemo: () => set({ demo: true, hasSession: true }),
  signOut: async () => {
    await clearTokens();
    useTenantStore.getState().clear();
    set({ hasSession: false, demo: false });
  },
}));

/** Non-React accessor for the fetch/realtime layers (outside the component tree). */
export const isDemoMode = (): boolean => useAuthStore.getState().demo;

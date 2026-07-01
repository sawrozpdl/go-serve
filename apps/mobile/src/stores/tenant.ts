/**
 * Active-workspace store, mirroring web's `lib/tenant.ts`. Holds the selected
 * tenant slug (sent as X-Tenant-ID) plus a light snapshot of its id/name for
 * chrome. Persisted to MMKV so the app reopens into the last workspace.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { mmkvStorage } from '../lib/zustandStorage';

export type ActiveTenant = {
  slug: string;
  id: string;
  name: string;
};

type TenantState = {
  active: ActiveTenant | null;
  setActive: (t: ActiveTenant) => void;
  clear: () => void;
};

export const useTenantStore = create<TenantState>()(
  persist(
    (set) => ({
      active: null,
      setActive: (active) => set({ active }),
      clear: () => set({ active: null }),
    }),
    { name: 'goserve-active-tenant', storage: createJSONStorage(() => mmkvStorage) },
  ),
);

/** Non-React accessor for the fetch layer. */
export const getActiveSlug = (): string | undefined =>
  useTenantStore.getState().active?.slug;

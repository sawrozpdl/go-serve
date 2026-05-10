// Active tenant slug, persisted to localStorage. The slug is sent as the
// X-Tenant-ID header on tenant-scoped API calls. Subdomain resolution is
// also supported by the backend but cookie-on-localhost limitations make
// header-based the dev default.

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type TenantState = {
  slug: string | null;
  setSlug: (slug: string | null) => void;
};

const useTenantStore = create<TenantState>()(
  persist(
    (set) => ({
      slug: null,
      setSlug: (slug) => set({ slug }),
    }),
    { name: 'cafe-active-tenant' },
  ),
);

export function useTenant() {
  const slug = useTenantStore((s) => s.slug);
  const setSlug = useTenantStore((s) => s.setSlug);
  return { slug, setSlug };
}

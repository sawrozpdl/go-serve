// Public, unauthenticated data layer for the customer-facing QR menu.
//
// Intentionally decoupled from lib/api.ts: it does NOT send the bearer token
// or the X-Tenant-ID header, and it must not pull the authed client (auth
// store, RBAC) into the lazily-loaded customer bundle. The slug travels in
// the URL path instead — a printed QR link is fully self-contained.

import { useQuery } from '@tanstack/react-query';

// Mirror of api.ts's API_BASE (duplicated rather than imported to keep the
// public chunk free of the authed client). Empty in dev → the Vite proxy
// forwards `/public/*` to the API; in prod it's the API origin.
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

export type PublicMenuItem = {
  id: string;
  name: string;
  description: string;
  price_cents: number;
  image_url?: string | null;
  icon: string;
  is_featured: boolean;
};

export type PublicMenuCategory = {
  id: string;
  name: string;
  icon: string;
  color?: string | null;
  image_url?: string | null;
  items: PublicMenuItem[];
};

export type PublicCafe = {
  name: string;
  slug: string;
  tagline?: string;
  logo_url?: string;
  accent_emoji?: string;
  currency: string;
  vat_pct: string;
  service_charge_pct: string;
  branding: {
    brandPrimary?: string;
    brandAccent?: string;
    mood?: string;
    typography?: string;
  };
};

export type PublicMenu = {
  cafe: PublicCafe;
  categories: PublicMenuCategory[];
};

export type PublicMenuError = { status: number; code?: string; message: string };

async function fetchPublicMenu(slug: string): Promise<PublicMenu> {
  const res = await fetch(`${API_BASE}/public/menu/${encodeURIComponent(slug)}`, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { message?: string; code?: string };
      if (j?.message) message = j.message;
      code = j?.code;
    } catch {
      /* non-JSON error body */
    }
    throw { status: res.status, code, message } as PublicMenuError;
  }
  return (await res.json()) as PublicMenu;
}

export function usePublicMenu(slug: string | undefined) {
  return useQuery<PublicMenu, PublicMenuError>({
    queryKey: ['public-menu', slug],
    enabled: !!slug,
    queryFn: () => fetchPublicMenu(slug!),
    staleTime: 60_000,
    // A 404 (unknown cafe) is terminal — don't hammer it. Other failures get a
    // couple of retries for transient network blips.
    retry: (count, err) => (err.status === 404 ? false : count < 2),
  });
}

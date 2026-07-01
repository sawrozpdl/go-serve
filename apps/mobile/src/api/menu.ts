/** Menu catalog reads for order-taking (categories, items, popular). */
import { useQuery } from '@tanstack/react-query';
import type { MenuCategory, MenuItem, PopularMenuItem } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

export function useMenuCategories() {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.menuCategories(slug ?? ''),
    queryFn: () =>
      api
        .get<{ categories: MenuCategory[] }>('/v1/menu/categories', { tenantSlug: slug })
        .then((r) => r.categories),
    enabled: !!slug,
  });
}

export function useMenuItems() {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.menuItems(slug ?? ''),
    queryFn: () =>
      api.get<{ items: MenuItem[] }>('/v1/menu/items', { tenantSlug: slug }).then((r) => r.items),
    enabled: !!slug,
  });
}

export function usePopularMenuItems(limit = 12) {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.popularItems(slug ?? ''),
    queryFn: () =>
      api
        .get<{ items: PopularMenuItem[] }>(`/v1/menu/popular?limit=${limit}`, { tenantSlug: slug })
        .then((r) => r.items),
    enabled: !!slug,
  });
}

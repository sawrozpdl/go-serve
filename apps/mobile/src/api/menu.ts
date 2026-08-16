/** Menu catalog reads for order-taking (categories, items, popular). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  MenuCategory,
  MenuItem,
  MenuItemInventoryLink,
  ModifierGroup,
  PopularMenuItem,
} from '@cafe-mgmt/api-types';
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

/** Add-on ("modifier") groups — the reusable catalog the POS resolves each
 *  item's offered add-ons from. See resolveModifierGroups. */
export function useModifierGroups() {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.modifierGroups(slug ?? ''),
    queryFn: () =>
      api
        .get<{ groups: ModifierGroup[] }>('/v1/menu/modifier-groups', { tenantSlug: slug })
        .then((r) => r.groups),
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

/** Inventory links for one menu item — which stock items it consumes and how
 *  much per sale (auto-deducted on order close). Mirrors web's useMenuItemLinks. */
export function useMenuItemLinks(menuItemId?: string) {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.menuItemLinks(slug ?? '', menuItemId ?? ''),
    queryFn: () =>
      api
        .get<{ links: MenuItemInventoryLink[] }>(`/v1/menu/items/${menuItemId}/inventory-link`, {
          tenantSlug: slug,
        })
        .then((r) => r.links ?? []),
    enabled: !!slug && !!menuItemId,
  });
}

/** Replace the full inventory-link set for a menu item (PUT is a wholesale
 *  replace — blank rows dropped by the caller). */
export function usePutMenuItemLinks() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      menuItemId: string;
      links: { inventory_item_id: string; qty_consumed_per_sale: string }[];
    }) =>
      api.put<{ links: MenuItemInventoryLink[] }>(
        `/v1/menu/items/${vars.menuItemId}/inventory-link`,
        { links: vars.links },
        { tenantSlug: slug },
      ),
    onSuccess: (_d, vars) =>
      void qc.invalidateQueries({ queryKey: qk.menuItemLinks(slug ?? '', vars.menuItemId) }),
  });
}

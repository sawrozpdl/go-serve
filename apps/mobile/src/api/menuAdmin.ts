/**
 * Menu management mutations (M7) — category + item CRUD. Reads (useMenuItems /
 * useMenuCategories / usePopularMenuItems) live in ./menu. All invalidate the
 * relevant menu queries so the POS + this manager stay consistent.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MenuCategory, MenuItem } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
}

function useInvalidateMenu() {
  const slug = useSlug();
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.menuCategories(slug ?? '') });
    void qc.invalidateQueries({ queryKey: qk.menuItems(slug ?? '') });
    void qc.invalidateQueries({ queryKey: qk.popularItems(slug ?? '') });
  };
}

export function useCreateMenuCategory() {
  const slug = useSlug();
  const invalidate = useInvalidateMenu();
  return useMutation({
    mutationFn: (body: Partial<MenuCategory>) => api.post<MenuCategory>('/v1/menu/categories', body, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export function useUpdateMenuCategory() {
  const slug = useSlug();
  const invalidate = useInvalidateMenu();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Partial<MenuCategory> }) =>
      api.patch<MenuCategory>(`/v1/menu/categories/${vars.id}`, vars.patch, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export function useDeleteMenuCategory() {
  const slug = useSlug();
  const invalidate = useInvalidateMenu();
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/menu/categories/${id}`, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export function useCreateMenuItem() {
  const slug = useSlug();
  const invalidate = useInvalidateMenu();
  return useMutation({
    mutationFn: (body: Partial<MenuItem>) => api.post<MenuItem>('/v1/menu/items', body, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export function useUpdateMenuItem() {
  const slug = useSlug();
  const invalidate = useInvalidateMenu();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Partial<MenuItem> }) =>
      api.patch<MenuItem>(`/v1/menu/items/${vars.id}`, vars.patch, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export function useDeleteMenuItem() {
  const slug = useSlug();
  const invalidate = useInvalidateMenu();
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/menu/items/${id}`, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

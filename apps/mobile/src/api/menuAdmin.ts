/**
 * Menu management mutations (M7) — category + item CRUD. Reads (useMenuItems /
 * useMenuCategories / usePopularMenuItems) live in ./menu. All invalidate the
 * relevant menu queries so the POS + this manager stay consistent.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  BulkImportPayload,
  BulkImportResult,
  MenuCategory,
  MenuItem,
  MenuModifier,
  ModifierGroup,
} from '@cafe-mgmt/api-types';
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

// --- add-ons ("modifiers", migration 0062) --------------------------------
//
// Add-ons are their own catalog, never menu items: reusable GROUPS of choices
// attached to items and/or categories. Mobile could consume them at the POS
// since 0062 but never manage them, so a cafe that wanted "extra shot" on its
// drinks had to open a laptop to say so once.
//
// Every write invalidates the group list AND the menu, because attaching a
// group changes what the POS offers on tap.

function useInvalidateAddOns() {
  const slug = useSlug();
  const qc = useQueryClient();
  const invalidateMenu = useInvalidateMenu();
  return () => {
    void qc.invalidateQueries({ queryKey: qk.modifierGroups(slug ?? '') });
    invalidateMenu();
  };
}

export type ModifierGroupInput = {
  name: string;
  min_select: number;
  /** null = unlimited picks. */
  max_select?: number | null;
  sort?: number;
  is_active?: boolean;
};

export function useCreateModifierGroup() {
  const slug = useSlug();
  const invalidate = useInvalidateAddOns();
  return useMutation({
    mutationFn: (body: ModifierGroupInput) =>
      api.post<ModifierGroup>('/v1/menu/modifier-groups', body, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export function useUpdateModifierGroup() {
  const slug = useSlug();
  const invalidate = useInvalidateAddOns();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Partial<ModifierGroupInput> }) =>
      api.patch<ModifierGroup>(`/v1/menu/modifier-groups/${vars.id}`, vars.patch, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export function useDeleteModifierGroup() {
  const slug = useSlug();
  const invalidate = useInvalidateAddOns();
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/menu/modifier-groups/${id}`, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export type ModifierInput = {
  name: string;
  /** Zero is legal — a free choice like "No sugar". */
  price_cents: number;
  cost_cents?: number | null;
  sort?: number;
  is_active?: boolean;
};

export function useCreateModifier(groupId: string) {
  const slug = useSlug();
  const invalidate = useInvalidateAddOns();
  return useMutation({
    mutationFn: (body: ModifierInput) =>
      api.post<MenuModifier>(`/v1/menu/modifier-groups/${groupId}/modifiers`, body, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export function useUpdateModifier(groupId: string) {
  const slug = useSlug();
  const invalidate = useInvalidateAddOns();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Partial<ModifierInput> }) =>
      api.patch<MenuModifier>(`/v1/menu/modifier-groups/${groupId}/modifiers/${vars.id}`, vars.patch, {
        tenantSlug: slug,
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteModifier(groupId: string) {
  const slug = useSlug();
  const invalidate = useInvalidateAddOns();
  return useMutation({
    mutationFn: (id: string) =>
      api.del(`/v1/menu/modifier-groups/${groupId}/modifiers/${id}`, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

/**
 * Attach groups to an item or a category. Whole-set PUTs, so they are
 * idempotent: send the complete list you want, not a delta.
 *
 * Item and category attachments COMPOSE rather than override — see
 * `resolveModifierGroups`. "All drinks get an extra shot" (category) and "this
 * latte also gets syrup" (item) must both be offered, so neither PUT can
 * clobber the other's set.
 */
export function usePutItemModifierGroups() {
  const slug = useSlug();
  const invalidate = useInvalidateAddOns();
  return useMutation({
    mutationFn: (vars: { itemId: string; groupIds: string[] }) =>
      api.put(`/v1/menu/items/${vars.itemId}/modifier-groups`, { group_ids: vars.groupIds }, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export function usePutCategoryModifierGroups() {
  const slug = useSlug();
  const invalidate = useInvalidateAddOns();
  return useMutation({
    mutationFn: (vars: { categoryId: string; groupIds: string[] }) =>
      api.put(
        `/v1/menu/categories/${vars.categoryId}/modifier-groups`,
        { group_ids: vars.groupIds },
        { tenantSlug: slug },
      ),
    onSuccess: invalidate,
  });
}

// --- bulk import ----------------------------------------------------------

/**
 * Upsert whole categories and items in one transaction, matched BY NAME.
 *
 * Always dry-run first. The endpoint validates everything up front because a
 * 4xx still commits the transaction it was in — so a partially-valid payload
 * that fails halfway would leave the menu half-imported, and the dry run is
 * what turns that from a hazard into a preview.
 *
 * Plan-gated (`menu_import`): an onboarding accelerator on higher tiers.
 * Manual entry stays available to every plan.
 */
export function useBulkImportMenu() {
  const slug = useSlug();
  const invalidate = useInvalidateMenu();
  return useMutation({
    mutationFn: (body: BulkImportPayload) =>
      api.post<BulkImportResult>('/v1/menu/import', body, { tenantSlug: slug }),
    onSuccess: (_r, body) => {
      // A dry run wrote nothing; re-reading the menu after one would only
      // cost a round-trip and make the preview feel slower than it is.
      if (!body.dry_run) invalidate();
    },
  });
}

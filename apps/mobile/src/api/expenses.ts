/** Expenses: list, detail, create, edit, delete, and their categories +
 *  vendor suggestions. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  Expense,
  ExpenseCategory,
  CreateExpenseInput,
  UpdateExpenseInput,
} from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
}

/** Server-side filters. They belong in the query key so two filter states never
 *  share a cache entry. */
export type ExpenseFilters = {
  from?: string;
  to?: string;
  q?: string;
  expense_category_id?: string;
  paid_from?: string;
};

function filterQuery(f: ExpenseFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function useExpenses(filters: ExpenseFilters = {}) {
  const slug = useSlug();
  return useQuery({
    queryKey: [...qk.expenses(slug ?? ''), filters],
    queryFn: () =>
      api
        .get<{ expenses: Expense[] }>(`/v1/expenses${filterQuery(filters)}`, { tenantSlug: slug })
        .then((r) => r.expenses),
    enabled: !!slug,
  });
}

/** One expense in full. The LIST rows don't carry allocations — only the detail
 *  read does — which is exactly why editing must never echo them back. */
export function useExpense(id: string | undefined) {
  const slug = useSlug();
  return useQuery({
    queryKey: [...qk.expenses(slug ?? ''), 'detail', id ?? ''],
    queryFn: () => api.get<Expense>(`/v1/expenses/${id}`, { tenantSlug: slug }),
    enabled: !!slug && !!id,
  });
}

export function useExpenseCategories() {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.expenseCategories(slug ?? ''),
    queryFn: () =>
      api.get<{ categories: ExpenseCategory[] }>('/v1/expense-categories', { tenantSlug: slug }).then((r) => r.categories),
    enabled: !!slug,
  });
}

export function useExpenseVendors() {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.expenseVendors(slug ?? ''),
    queryFn: () => api.get<{ vendors: string[] }>('/v1/expenses/vendors', { tenantSlug: slug }).then((r) => r.vendors),
    enabled: !!slug,
  });
}

export function useCreateExpense() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateExpenseInput) => api.post<Expense>('/v1/expenses', body, { tenantSlug: slug }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.expenses(slug ?? '') });
      void qc.invalidateQueries({ queryKey: qk.expenseVendors(slug ?? '') });
      // A drawer-paid expense moves shift cash; refresh the drawer view too.
      void qc.invalidateQueries({ queryKey: qk.currentShift(slug ?? '') });
    },
  });
}

/**
 * Edit an expense.
 *
 * Two server rules this deliberately encodes rather than discovers at runtime:
 *
 *  1. `allocations` is a POINTER server-side: omit the key and the existing
 *     split is left alone; send it — even as `[]` — and the split is REPLACED.
 *     Mobile has no allocation editor (cost centres feed the Profitability
 *     report, which stays on web), so it must never send the key at all, or a
 *     phone edit would silently wipe a split set on the dashboard.
 *  2. `paid_from`, `owner_id`, `shift_id`, `payment_method`,
 *     `linked_inventory_item_id` and `delta_units` are immutable — sending any
 *     of them returns 400 `immutable_field`. Changing the money source would
 *     rewrite ledgers; delete and re-create instead.
 *
 * The type below is the allowed subset, so neither rule can be broken by
 * accident.
 */
export type EditableExpenseFields = Omit<UpdateExpenseInput, 'allocations'>;

export function useUpdateExpense() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: EditableExpenseFields }) =>
      api.patch<Expense>(`/v1/expenses/${vars.id}`, vars.patch, { tenantSlug: slug }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: qk.expenses(slug ?? '') });
      void qc.invalidateQueries({ queryKey: [...qk.expenses(slug ?? ''), 'detail', vars.id] });
      void qc.invalidateQueries({ queryKey: qk.expenseVendors(slug ?? '') });
      void qc.invalidateQueries({ queryKey: qk.currentShift(slug ?? '') });
    },
  });
}

export function useDeleteExpense() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/expenses/${id}`, { tenantSlug: slug }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.expenses(slug ?? '') });
      // A drawer-paid expense posted a cash drop; removing it gives the cash
      // back, so the drawer view has to be re-read.
      void qc.invalidateQueries({ queryKey: qk.currentShift(slug ?? '') });
      // Every shift's drop list — the prefix matches whichever shift it was.
      void qc.invalidateQueries({ queryKey: ['cash-drops', slug ?? ''] });
    },
  });
}

// --- categories -----------------------------------------------------------
// Managed from inside the Expenses screen, exactly as on web — this is depth
// on an existing surface, not a new one.

export function useCreateExpenseCategory() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; icon?: string }) =>
      api.post<ExpenseCategory>('/v1/expense-categories', body, { tenantSlug: slug }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.expenseCategories(slug ?? '') }),
  });
}

export function useUpdateExpenseCategory() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; patch: { name?: string; icon?: string } }) =>
      api.patch<ExpenseCategory>(`/v1/expense-categories/${vars.id}`, vars.patch, { tenantSlug: slug }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.expenseCategories(slug ?? '') }),
  });
}

export function useDeleteExpenseCategory() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/expense-categories/${id}`, { tenantSlug: slug }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.expenseCategories(slug ?? '') });
      // Expenses in that category lose it, so the list text changes too.
      void qc.invalidateQueries({ queryKey: qk.expenses(slug ?? '') });
    },
  });
}

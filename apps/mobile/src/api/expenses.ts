/** Expenses (M8): list, create, and their categories + vendor suggestions. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Expense, ExpenseCategory, CreateExpenseInput } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
}

export function useExpenses() {
  const slug = useSlug();
  return useQuery({
    queryKey: qk.expenses(slug ?? ''),
    queryFn: () => api.get<{ expenses: Expense[] }>('/v1/expenses', { tenantSlug: slug }).then((r) => r.expenses),
    enabled: !!slug,
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

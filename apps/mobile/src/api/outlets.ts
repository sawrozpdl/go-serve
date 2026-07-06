/** Outlets — prep destinations (Kitchen, Bar, …) and their printers. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Outlet } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

export function useOutlets() {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.outlets(slug ?? ''),
    queryFn: () =>
      api.get<{ outlets: Outlet[] }>('/v1/outlets', { tenantSlug: slug }).then((r) => r.outlets),
    enabled: !!slug,
  });
}

function useInvalidateOutlets() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: qk.outlets(slug ?? '') });
}

export function useCreateOutlet() {
  const slug = useTenantStore((s) => s.active?.slug);
  const invalidate = useInvalidateOutlets();
  return useMutation({
    mutationFn: (body: Partial<Outlet>) => api.post<Outlet>('/v1/outlets', body, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export function useUpdateOutlet() {
  const slug = useTenantStore((s) => s.active?.slug);
  const invalidate = useInvalidateOutlets();
  return useMutation({
    mutationFn: (vars: { id: string; patch: Partial<Outlet> }) =>
      api.patch<Outlet>(`/v1/outlets/${vars.id}`, vars.patch, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

export function useDeleteOutlet() {
  const slug = useTenantStore((s) => s.active?.slug);
  const invalidate = useInvalidateOutlets();
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/outlets/${id}`, { tenantSlug: slug }),
    onSuccess: invalidate,
  });
}

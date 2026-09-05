/**
 * Staff registry — read-only on mobile. The floor needs it for one thing:
 * attributing a staff meal to a person. Editing the registry stays on the web
 * dashboard, so there is no mutation here.
 */
import { useQuery } from '@tanstack/react-query';
import type { Staff } from '@cafe-mgmt/api-types';
import { api } from './client';
import { useTenantStore } from '../stores/tenant';

export function useStaffList() {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: ['staff', slug],
    queryFn: () => api.get<{ staff: Staff[] }>('/v1/staff', { tenantSlug: slug }).then((r) => r.staff),
    enabled: !!slug,
  });
}

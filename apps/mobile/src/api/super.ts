/**
 * Platform super-admin (M10). Cross-tenant console for platform admins
 * (is_platform_admin). These endpoints are tenant-LESS — we pass no
 * X-Tenant-ID (the server scopes by the platform-admin identity instead).
 * Mobile ships a read console (tenants + detail); destructive plan/billing
 * actions stay on the web console.
 */
import { useQuery } from '@tanstack/react-query';
import type { AdminTenantsResponse, AdminTenantDetail } from '@cafe-mgmt/api-types';
import { api } from './client';

export function useSuperTenants() {
  return useQuery({
    queryKey: ['super-tenants'],
    queryFn: () => api.get<AdminTenantsResponse>('/v1/super/tenants'),
  });
}

export function useSuperTenant(id: string | undefined) {
  return useQuery({
    queryKey: ['super-tenant', id],
    queryFn: () => api.get<AdminTenantDetail>(`/v1/super/tenants/${id}`),
    enabled: !!id,
  });
}

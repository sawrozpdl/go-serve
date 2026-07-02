/** Team (M9) — members, their roles, invites, and the tenant role catalog. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Member, Invite, Role, TenantRole } from '@cafe-mgmt/api-types';
import { api } from './client';
import { useTenantStore } from '../stores/tenant';

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
}

export function useMembers() {
  const slug = useSlug();
  return useQuery({
    queryKey: ['members', slug],
    queryFn: () => api.get<{ members: Member[] }>('/v1/members', { tenantSlug: slug }).then((r) => r.members),
    enabled: !!slug,
  });
}

export function useInvites() {
  const slug = useSlug();
  return useQuery({
    queryKey: ['invites', slug],
    queryFn: () => api.get<{ invites: Invite[] }>('/v1/invites', { tenantSlug: slug }).then((r) => r.invites),
    enabled: !!slug,
  });
}

export function useRoles() {
  const slug = useSlug();
  return useQuery({
    queryKey: ['roles', slug],
    queryFn: () => api.get<{ roles: Role[] }>('/v1/roles', { tenantSlug: slug }).then((r) => r.roles),
    enabled: !!slug,
  });
}

export function useUpdateMemberRoles() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { userId: string; roles: TenantRole[] }) =>
      api.patch(`/v1/members/${vars.userId}/roles`, { roles: vars.roles }, { tenantSlug: slug }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members', slug] }),
  });
}

export function useRemoveMember() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api.del(`/v1/members/${userId}`, { tenantSlug: slug }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['members', slug] }),
  });
}

export function useCreateInvite() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { email: string; roles: TenantRole[] }) => api.post<Invite>('/v1/invites', body, { tenantSlug: slug }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invites', slug] }),
  });
}

export function useRevokeInvite() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/v1/invites/${id}`, { tenantSlug: slug }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['invites', slug] }),
  });
}

/** Kitchen tickets — the board reads (M4) + the mark-ready/served mutation. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KitchenTicket, KitchenStatus } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

export function useKitchenTickets() {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.kitchenTickets(slug ?? ''),
    queryFn: () =>
      api
        .get<{ tickets: KitchenTicket[] }>('/v1/kitchen/tickets', { tenantSlug: slug })
        .then((r) => r.tickets),
    enabled: !!slug,
  });
}

export function useUpdateKitchenTicket() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { itemId: string; kitchen_status: Extract<KitchenStatus, 'ready' | 'served'> }) =>
      api.patch(
        `/v1/kitchen/tickets/${vars.itemId}`,
        { kitchen_status: vars.kitchen_status },
        { tenantSlug: slug },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.kitchenTickets(slug ?? '') }),
  });
}

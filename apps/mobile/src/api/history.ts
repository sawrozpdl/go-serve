/** Order history — day-wise closed serves. */
import { useQuery } from '@tanstack/react-query';
import type { OrderHistoryResp } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

/** Closed orders for a day (YYYY-MM-DD). */
export function useOrderHistory(date: string) {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: qk.orderHistory(slug ?? '', date),
    queryFn: () => api.get<OrderHistoryResp>(`/v1/orders/history?date=${date}`, { tenantSlug: slug }),
    enabled: !!slug,
  });
}

/** Order history — day-wise closed serves, optionally for one table. */
import { useQuery } from '@tanstack/react-query';
import type { OrderHistoryResp } from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

/**
 * Closed orders for a day (YYYY-MM-DD), narrowed to one table when given.
 *
 * The table id is part of the cache key: two filter states must never share an
 * entry, or switching tables shows the previous one's serves. Note the server
 * omits `credit_collections` entirely while a table filter is on — a tab
 * belongs to a person, not a table — so the day's credit figure disappears with
 * the filter rather than being silently mis-scoped.
 */
export function useOrderHistory(date: string, tableId?: string) {
  const slug = useTenantStore((s) => s.active?.slug);
  return useQuery({
    queryKey: [...qk.orderHistory(slug ?? '', date), tableId ?? 'all'],
    queryFn: () => {
      const qs = new URLSearchParams({ date });
      if (tableId) qs.set('table_id', tableId);
      return api.get<OrderHistoryResp>(`/v1/orders/history?${qs.toString()}`, { tenantSlug: slug });
    },
    enabled: !!slug,
  });
}

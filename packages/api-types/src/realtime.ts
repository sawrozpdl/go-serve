// Realtime WebSocket event → TanStack Query invalidation mapping.
//
// Events do NOT carry full state — they're cache-bust hints; the query refetch
// is the source of truth. This pure function is the single place both web and
// mobile decide which query keys a given event invalidates, so the two clients
// can never drift. Ported verbatim from apps/web/src/lib/ws.ts `dispatch()`.

export type WSTopic = 'kitchen' | 'tables' | 'orders' | 'finance';

export type WSEventRef = {
  order_id?: string;
  item_id?: string;
  service_table_id?: string;
  owner_id?: string;
  loan_id?: string;
};

export type WSEvent = {
  topic: WSTopic;
  action: string;
  ref?: WSEventRef;
};

/** A TanStack Query key prefix to invalidate. Prefix-matches broader keys
 * (e.g. `['orders']` invalidates `['orders', slug]`). */
export type InvalidationKey = readonly (string | undefined)[];

/**
 * Map a realtime event to the query-key prefixes that should be invalidated.
 * Kept narrow (not "invalidate everything") to avoid refetch storms on a busy
 * floor. Unknown topics return no invalidations.
 */
export function mapEventToInvalidations(ev: WSEvent, slug: string): InvalidationKey[] {
  switch (ev.topic) {
    case 'kitchen':
      return [['kitchen-tickets', slug]];
    case 'tables':
      // Floor view also reads orders to overlay tab amounts.
      return [['tables', slug], ['orders']];
    case 'orders': {
      const keys: InvalidationKey[] = [['orders']];
      const orderID = ev.ref?.order_id;
      if (orderID) keys.push(['order', slug, orderID]);
      // Item-level changes refresh kitchen tickets + the settle quote so an
      // open settle view on another device reflects newly added/voided lines.
      if (ev.action.startsWith('order.item.') || ev.action === 'order.items.sent') {
        keys.push(['kitchen-tickets', slug]);
        if (orderID) keys.push(['order-quote', slug, orderID]);
      }
      // Payment events move drawer money — refresh the payment list, quote, and
      // the shift's live expected-cash on other devices.
      if (ev.action.startsWith('order.payment.')) {
        if (orderID) {
          keys.push(['order-payments', slug, orderID]);
          keys.push(['order-quote', slug, orderID]);
        }
        keys.push(['current-shift', slug]);
        keys.push(['shift-payments', slug]);
      }
      return keys;
    }
    case 'finance':
      return [['cafe-balance'], ['cafe-owners'], ['owner-ledger'], ['accounts-balances']];
    default:
      return [];
  }
}

/** The query families the HTTP-poll fallback refreshes when the socket is down
 * (mirrors web's `pollAll`). */
export function pollInvalidations(slug: string): InvalidationKey[] {
  return [['kitchen-tickets', slug], ['tables', slug], ['orders'], ['order']];
}

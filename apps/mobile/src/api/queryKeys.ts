/**
 * Centralized query keys. These MUST match web's literal key shapes so the
 * WebSocket → invalidation mapping (M2, ported from web's ws.ts) works
 * verbatim. Add keys here as milestones introduce them.
 */
export const qk = {
  authConfig: ['auth-config'] as const,
  me: (slug?: string) => ['me', slug ?? null] as const,

  // POS / operational (used from M2 on) — keep in sync with web.
  menuCategories: (slug: string) => ['menu-categories', slug] as const,
  menuItems: (slug: string) => ['menu-items', slug] as const,
  tables: (slug: string) => ['tables', slug] as const,
  orders: (slug: string) => ['orders', slug] as const,
  order: (slug: string, orderId: string) => ['order', slug, orderId] as const,
  orderQuote: (slug: string, orderId: string) => ['order-quote', slug, orderId] as const,
  kitchenTickets: (slug: string) => ['kitchen-tickets', slug] as const,
  currentShift: (slug: string) => ['current-shift', slug] as const,
} as const;

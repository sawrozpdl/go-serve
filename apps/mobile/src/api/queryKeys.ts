/**
 * Centralized query keys. These MUST match web's literal key shapes so the
 * WebSocket → invalidation mapping (mapEventToInvalidations, from api-types)
 * prefix-matches them. Add keys here as milestones introduce them.
 */
export const qk = {
  authConfig: ['auth-config'] as const,
  me: (slug?: string) => ['me', slug ?? null] as const,

  tenantSettings: (slug: string) => ['tenant-settings', slug] as const,

  // POS / operational — keep in sync with web's WS invalidation prefixes.
  menuCategories: (slug: string) => ['menu-categories', slug] as const,
  menuItems: (slug: string) => ['menu-items', slug] as const,
  popularItems: (slug: string) => ['menu-popular', slug] as const,
  tables: (slug: string) => ['tables', slug] as const,
  orders: (slug: string, status?: string) => ['orders', slug, status ?? 'open'] as const,
  order: (slug: string, orderId: string) => ['order', slug, orderId] as const,
  orderQuote: (slug: string, orderId: string) => ['order-quote', slug, orderId] as const,
  orderPayments: (slug: string, orderId: string) => ['order-payments', slug, orderId] as const,
  orderAdjustments: (slug: string, orderId: string) => ['order-adjustments', slug, orderId] as const,
  houseTabs: (slug: string) => ['house-tabs', slug] as const,
  kitchenTickets: (slug: string) => ['kitchen-tickets', slug] as const,
  currentShift: (slug: string) => ['current-shift', slug] as const,
  inventory: (slug: string) => ['inventory', slug] as const,
  inventoryMovements: (slug: string, id: string) => ['inventory-movements', slug, id] as const,
} as const;

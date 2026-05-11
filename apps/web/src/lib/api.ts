// Typed API client + TanStack Query hooks for the GoServe API.
//
// URL strategy:
//   - In dev, VITE_API_BASE_URL is empty. Paths like `/v1/...` are relative,
//     and the Vite proxy (vite.config.ts) forwards them to the API. Cookies
//     stay first-party because the browser sees a single origin.
//   - In prod, set VITE_API_BASE_URL to the API origin, e.g.
//     `https://api.cafe.example.com`. The client builds absolute URLs and
//     relies on `credentials: 'include'` + the API's CORS allow-list.
//
// Tenant scope is sent via the X-Tenant-ID header (subdomain cookie sharing
// on .localhost is broken — see auth/session.go).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryOptions, UseMutationOptions } from '@tanstack/react-query';

import { useTenant } from './tenant';

export type ApiError = { status: number; message: string; code?: string };

// Trimmed of any trailing slash so `${API_BASE}/v1/...` is always well-formed.
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

function url(path: string): string {
  return API_BASE + path;
}

// One-shot: clear the persisted active tenant and bounce to the workspace
// picker. Guarded so a burst of parallel 403s doesn't trigger N navigations.
let staleTenantHandled = false;
function handleStaleTenant() {
  if (staleTenantHandled) return;
  staleTenantHandled = true;
  try {
    // Matches `name: 'cafe-active-tenant'` in lib/tenant.ts.
    localStorage.removeItem('cafe-active-tenant');
  } catch {
    /* */
  }
  if (typeof window !== 'undefined' && window.location.pathname !== '/pick-workspace') {
    // Hard nav rather than react-router; we're outside the component tree.
    window.location.replace('/pick-workspace');
  }
}

async function request<T>(
  method: string,
  path: string,
  opts: { tenantSlug?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.tenantSlug) headers['X-Tenant-ID'] = opts.tenantSlug;

  const res = await fetch(url(path), {
    method,
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    try {
      const j = (await res.json()) as { message?: string; code?: string };
      if (j.message) message = j.message;
      code = j.code;
    } catch {
      /* ignore */
    }
    const err: ApiError = { status: res.status, message, code };
    // Stale tenant slug in localStorage from a previous session, or the
    // user's membership was revoked. Clear it and bounce to the picker so
    // the UI doesn't get stuck firing 403s against a dead workspace.
    if (
      opts.tenantSlug &&
      (code === 'not_a_member' || code === 'tenant_not_found')
    ) {
      handleStaleTenant();
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// =========================================================================
// Auth
// =========================================================================

export type TenantRole = 'owner' | 'manager' | 'waiter' | 'kitchen';

export type Membership = {
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  /** Every hat the user wears in this tenant (e.g. waiter+kitchen). */
  roles: TenantRole[];
  status: 'active' | 'pending' | 'suspended';
};

export type Me = {
  user_id: string;
  email: string;
  name: string;
  active_tenant_slug?: string;
  active_roles?: TenantRole[];
  memberships: Membership[];
};

/** True if the active membership holds the given role on this tenant. */
export function hasRole(me: Me | undefined, want: TenantRole): boolean {
  return !!me?.active_roles?.includes(want);
}

/** True if the active membership holds at least one of the given roles. */
export function hasAnyRole(me: Me | undefined, ...wants: TenantRole[]): boolean {
  const have = me?.active_roles ?? [];
  return wants.some((w) => have.includes(w));
}

export function useMe(opts?: Partial<UseQueryOptions<Me, ApiError>>) {
  const { slug } = useTenant();
  return useQuery<Me, ApiError>({
    queryKey: ['me', slug ?? null],
    queryFn: () => request<Me>('GET', '/v1/me', { tenantSlug: slug ?? undefined }),
    retry: false,
    ...opts,
  });
}

export type AuthConfig = {
  google_enabled: boolean;
  dev_login_enabled: boolean;
};

// /auth/config tells us which login methods the server has mounted. Cached
// for the session — server config doesn't change between requests.
export function useAuthConfig() {
  return useQuery<AuthConfig, ApiError>({
    queryKey: ['auth', 'config'],
    queryFn: () => request<AuthConfig>('GET', '/auth/config'),
    staleTime: Infinity,
    retry: false,
  });
}

export function useDevLogin() {
  const qc = useQueryClient();
  return useMutation<{ user_id: string; session_id: string; token: string }, ApiError, { email: string; name?: string }>({
    mutationFn: (vars) => request('POST', '/auth/dev-login', { body: vars }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, ApiError>({
    mutationFn: () => request('POST', '/auth/logout'),
    onSuccess: () => qc.clear(),
  });
}

// =========================================================================
// Menu categories
// =========================================================================

export type MenuCategory = {
  id: string;
  name: string;
  sort: number;
  color?: string | null;
  is_active: boolean;
};

type ListResp<K extends string, T> = { [P in K]: T[] };

export function useMenuCategories() {
  const { slug } = useTenant();
  return useQuery<MenuCategory[], ApiError>({
    queryKey: ['menu-categories', slug],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'categories', MenuCategory>>('GET', '/v1/menu/categories', { tenantSlug: slug! }).then((r) => r.categories),
  });
}

export function useCreateMenuCategory(opts?: UseMutationOptions<MenuCategory, ApiError, Partial<MenuCategory>>) {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<MenuCategory, ApiError, Partial<MenuCategory>>({
    mutationFn: (body) => request('POST', '/v1/menu/categories', { tenantSlug: slug!, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu-categories'] }),
    ...opts,
  });
}

export function useUpdateMenuCategory() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<MenuCategory, ApiError, { id: string; patch: Partial<MenuCategory> }>({
    mutationFn: ({ id, patch }) => request('PATCH', `/v1/menu/categories/${id}`, { tenantSlug: slug!, body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu-categories'] }),
  });
}

export function useDeleteMenuCategory() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => request('DELETE', `/v1/menu/categories/${id}`, { tenantSlug: slug! }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu-categories'] }),
  });
}

// =========================================================================
// Menu items
// =========================================================================

export type MenuItem = {
  id: string;
  category_id: string;
  name: string;
  description: string;
  price_cents: number;
  /** Cafe's own per-unit cost (production / wholesale). null = unset.
   *  Captured onto order_items at sale time so historical reports stay
   *  stable even if you tune the cost later. */
  cost_cents?: number | null;
  sku?: string | null;
  image_url?: string | null;
  is_active: boolean;
  sort: number;
  modifiers: unknown;
};

export function useMenuItems(categoryId?: string) {
  const { slug } = useTenant();
  return useQuery<MenuItem[], ApiError>({
    queryKey: ['menu-items', slug, categoryId ?? 'all'],
    enabled: !!slug,
    queryFn: () => {
      const qs = categoryId ? `?category_id=${categoryId}` : '';
      return request<ListResp<'items', MenuItem>>('GET', `/v1/menu/items${qs}`, { tenantSlug: slug! }).then((r) => r.items);
    },
  });
}

export function useCreateMenuItem() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<MenuItem, ApiError, Partial<MenuItem>>({
    mutationFn: (body) => request('POST', '/v1/menu/items', { tenantSlug: slug!, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu-items'] }),
  });
}

export function useUpdateMenuItem() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<MenuItem, ApiError, { id: string; patch: Partial<MenuItem> }>({
    mutationFn: ({ id, patch }) => request('PATCH', `/v1/menu/items/${id}`, { tenantSlug: slug!, body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu-items'] }),
  });
}

export function useDeleteMenuItem() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => request('DELETE', `/v1/menu/items/${id}`, { tenantSlug: slug! }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['menu-items'] }),
  });
}

// =========================================================================
// Service tables
// =========================================================================

export type ServiceTable = {
  id: string;
  name: string;
  capacity: number;
  area: string;
  status: 'free' | 'occupied' | 'reserved' | 'dirty';
  sort: number;
};

export function useServiceTables() {
  const { slug } = useTenant();
  return useQuery<ServiceTable[], ApiError>({
    queryKey: ['tables', slug],
    enabled: !!slug,
    queryFn: () => request<ListResp<'tables', ServiceTable>>('GET', '/v1/tables', { tenantSlug: slug! }).then((r) => r.tables),
  });
}

export function useCreateServiceTable() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<ServiceTable, ApiError, Partial<ServiceTable>>({
    mutationFn: (body) => request('POST', '/v1/tables', { tenantSlug: slug!, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tables'] }),
  });
}

export function useUpdateServiceTable() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<ServiceTable, ApiError, { id: string; patch: Partial<ServiceTable> }>({
    mutationFn: ({ id, patch }) => request('PATCH', `/v1/tables/${id}`, { tenantSlug: slug!, body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tables'] }),
  });
}

export function useDeleteServiceTable() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => request('DELETE', `/v1/tables/${id}`, { tenantSlug: slug! }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tables'] }),
  });
}

// =========================================================================
// Orders / tabs
// =========================================================================

export type OrderStatus = 'open' | 'closed' | 'cancelled';
export type KitchenStatus = 'pending' | 'in_progress' | 'ready' | 'served';

export type OrderItemRow = {
  id: string;
  order_id: string;
  menu_item_id: string;
  menu_item_name: string;
  qty: number;
  unit_price_cents: number;
  line_cents: number;
  modifiers: unknown;
  notes: string;
  kitchen_status: KitchenStatus;
  sent_to_kitchen_at?: string | null;
  ready_at?: string | null;
  served_at?: string | null;
  voided_at?: string | null;
  void_reason?: string | null;
  created_at: string;
};

export type Order = {
  id: string;
  service_table_id?: string | null;
  service_table_name?: string | null;
  status: OrderStatus;
  opened_by_user_id: string;
  opened_at: string;
  closed_at?: string | null;
  notes: string;
  subtotal_cents: number;
  discount_cents: number;
  tax_cents: number;
  service_charge_cents: number;
  total_cents: number;
  live_subtotal_cents: number;
  items?: OrderItemRow[];
  // Per-status non-voided item counts. Populated by list+get; lets the
  // floor + tab pages show "all served · settle pending" style labels
  // without loading every order's full item array.
  items_pending: number;
  items_in_progress: number;
  items_ready: number;
  items_served: number;
  items_total: number;
  paid_cents: number;
};

/**
 * Derive a single, action-oriented label for an OPEN tab from its item-status
 * counts and paid amount. Priority is ordered by who needs to do something
 * next: server action (ready to serve) > waiting on kitchen > waiting on the
 * cashier (settle) > nothing yet. Returns null for closed/cancelled orders —
 * those have their own status field.
 */
export type TabState = {
  key:
    | 'empty'
    | 'ordering'
    | 'cooking'
    | 'ready-to-serve'
    | 'served-settle'
    | 'served-partial-paid'
    | 'new-items-after-send';
  /** Short label, lowercase. Suitable for a pill. */
  label: string;
  /** One-line description for tooltip / secondary text. */
  hint: string;
  /** Tone bucket for styling. */
  tone: 'neutral' | 'info' | 'warn' | 'action' | 'success';
};

export function deriveTabState(o: Order): TabState | null {
  if (o.status !== 'open') return null;

  const total = o.items_total ?? 0;
  const pending = o.items_pending ?? 0;
  const inProg = o.items_in_progress ?? 0;
  const ready = o.items_ready ?? 0;
  const served = o.items_served ?? 0;
  const inFlight = pending + inProg + ready;

  if (total === 0) {
    return { key: 'empty', label: 'new tab', hint: 'no items yet', tone: 'neutral' };
  }
  if (ready > 0) {
    return {
      key: 'ready-to-serve',
      label: `${ready} ready · serve`,
      hint: 'kitchen has items ready to be served',
      tone: 'action',
    };
  }
  if (pending > 0 && served > 0 && inProg === 0) {
    return {
      key: 'new-items-after-send',
      label: `${pending} new · send to kitchen`,
      hint: 'new items added to a partly-served tab',
      tone: 'warn',
    };
  }
  if (inProg > 0) {
    return {
      key: 'cooking',
      label: pending > 0 ? `${inProg} cooking · ${pending} not sent` : `${inProg} cooking`,
      hint: 'kitchen is working on items',
      tone: 'info',
    };
  }
  if (pending > 0) {
    return {
      key: 'ordering',
      label: `${pending} not sent`,
      hint: 'items added but not sent to kitchen yet',
      tone: 'warn',
    };
  }
  // All non-voided items are served (inFlight === 0, served === total).
  if (inFlight === 0 && served === total) {
    if ((o.paid_cents ?? 0) === 0) {
      return {
        key: 'served-settle',
        label: 'all served · settle',
        hint: 'every item served — collect payment to close',
        tone: 'action',
      };
    }
    return {
      key: 'served-partial-paid',
      label: 'all served · part paid',
      hint: 'partial payment recorded — collect balance to close',
      tone: 'action',
    };
  }
  return { key: 'empty', label: 'open tab', hint: '', tone: 'neutral' };
}

export function useOrders(status?: OrderStatus) {
  const { slug } = useTenant();
  return useQuery<Order[], ApiError>({
    queryKey: ['orders', slug, status ?? 'all'],
    enabled: !!slug,
    queryFn: () => {
      const qs = status ? `?status=${status}` : '';
      return request<ListResp<'orders', Order>>('GET', `/v1/orders${qs}`, { tenantSlug: slug! }).then((r) => r.orders);
    },
  });
}

export function useOrder(orderId: string | undefined) {
  const { slug } = useTenant();
  return useQuery<Order, ApiError>({
    queryKey: ['order', slug, orderId],
    enabled: !!slug && !!orderId,
    queryFn: () => request<Order>('GET', `/v1/orders/${orderId}`, { tenantSlug: slug! }),
  });
}

export function useOpenOrder() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<Order, ApiError, { service_table_id?: string; notes?: string }>({
    mutationFn: (body) => request('POST', '/v1/orders', { tenantSlug: slug!, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['tables'] });
    },
  });
}

export function useAddOrderItems() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    { items: OrderItemRow[] },
    ApiError,
    { orderId: string; items: { menu_item_id: string; qty: number; notes?: string; modifiers?: unknown }[] }
  >({
    mutationFn: ({ orderId, items }) =>
      request('POST', `/v1/orders/${orderId}/items`, { tenantSlug: slug!, body: { items } }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['order', slug, vars.orderId] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

export function useUpdateOrderItem() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    void,
    ApiError,
    { orderId: string; itemId: string; patch: { qty?: number; notes?: string; modifiers?: unknown } }
  >({
    mutationFn: ({ orderId, itemId, patch }) =>
      request('PATCH', `/v1/orders/${orderId}/items/${itemId}`, { tenantSlug: slug!, body: patch }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['order', slug, vars.orderId] });
    },
  });
}

export type Approval = { approver_email?: string; approver_pin?: string };

export function useVoidOrderItem() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    void,
    ApiError,
    { orderId: string; itemId: string; reason: string } & Approval
  >({
    mutationFn: ({ orderId, itemId, ...body }) =>
      request('POST', `/v1/orders/${orderId}/items/${itemId}/void`, { tenantSlug: slug!, body }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['order', slug, vars.orderId] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

// =========================================================================
// Discounts / order adjustments (M11)
// =========================================================================

export type AdjustmentType = 'discount' | 'service_charge' | 'tax_override';

export type OrderAdjustment = {
  id: string;
  order_id: string;
  type: AdjustmentType;
  amount_cents: number;
  reason: string;
  applied_by_user_id: string;
  approved_by_user_id: string;
  created_at: string;
};

export function useOrderAdjustments(orderId?: string) {
  const { slug } = useTenant();
  return useQuery<OrderAdjustment[], ApiError>({
    queryKey: ['order-adjustments', slug, orderId],
    enabled: !!slug && !!orderId,
    queryFn: () =>
      request<ListResp<'adjustments', OrderAdjustment>>(
        'GET',
        `/v1/orders/${orderId}/adjustments`,
        { tenantSlug: slug! },
      ).then((r) => r.adjustments),
  });
}

export function useApplyAdjustment() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    OrderAdjustment,
    ApiError,
    { orderId: string; type: AdjustmentType; amount_cents: number; reason: string } & Approval
  >({
    mutationFn: ({ orderId, ...body }) =>
      request('POST', `/v1/orders/${orderId}/adjustments`, { tenantSlug: slug!, body }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['order-adjustments', slug, vars.orderId] });
      qc.invalidateQueries({ queryKey: ['order-quote', slug, vars.orderId] });
    },
  });
}

export function useRemoveAdjustment() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, { orderId: string; adjId: string } & Approval>({
    mutationFn: ({ orderId, adjId, ...body }) =>
      request('DELETE', `/v1/orders/${orderId}/adjustments/${adjId}`, {
        tenantSlug: slug!,
        body,
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['order-adjustments', slug, vars.orderId] });
      qc.invalidateQueries({ queryKey: ['order-quote', slug, vars.orderId] });
    },
  });
}

export function useSetMyPin() {
  const { slug } = useTenant();
  return useMutation<void, ApiError, { pin: string }>({
    mutationFn: (body) => request('POST', '/v1/me/pin', { tenantSlug: slug!, body }),
  });
}

// =========================================================================
// Tenant settings + branding (M12)
// =========================================================================

export type MoodKey =
  | 'amber-dawn'
  | 'rose-bistro'
  | 'forest-cottage'
  | 'cobalt-modern'
  | 'crimson-trattoria'
  | 'mocha-warm'
  | 'midnight-jazz'
  | 'matcha-zen'
  | 'noir-speakeasy'
  | 'sunset-coast'
  | 'sakura-bloom'
  | 'desert-dune';

export type TypographyKey = 'editorial' | 'modern' | 'minimal';

export type TenantBranding = {
  brandPrimary?: string;
  brandAccent?: string;
  cafeName?: string;
  logoUrl?: string;
  wordmarkUrl?: string;
  mood?: MoodKey;
  tagline?: string;
  accentEmoji?: string;
  typography?: TypographyKey;
};

export type TenantSettings = {
  id: string;
  slug: string;
  name: string;
  branding: TenantBranding;
  plan: string;
  status: string;
  timezone: string;
  vat_pct: string;
  service_charge_pct: string;
  created_at: string;
};

export function useTenantSettings() {
  const { slug } = useTenant();
  return useQuery<TenantSettings, ApiError>({
    queryKey: ['tenant-settings', slug],
    enabled: !!slug,
    queryFn: () => request<TenantSettings>('GET', '/v1/tenant', { tenantSlug: slug! }),
  });
}

export function useUpdateTenant() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    TenantSettings,
    ApiError,
    {
      name?: string;
      timezone?: string;
      vat_pct?: string;
      service_charge_pct?: string;
      branding?: Partial<TenantBranding>;
    }
  >({
    mutationFn: (body) => request('PATCH', '/v1/tenant', { tenantSlug: slug!, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant-settings', slug] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

export function useUploadTenantLogo() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<{ logo_url: string }, ApiError, File>({
    mutationFn: async (file) => {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(url('/v1/tenant/logo'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Tenant-ID': slug! },
        body: fd,
      });
      if (!res.ok) {
        let message = res.statusText;
        let code: string | undefined;
        try {
          const j = (await res.json()) as { message?: string; code?: string };
          if (j.message) message = j.message;
          code = j.code;
        } catch {
          /* */
        }
        throw { status: res.status, message, code } as ApiError;
      }
      return (await res.json()) as { logo_url: string };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant-settings', slug] });
    },
  });
}

export function useSendOrderToKitchen() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<{ sent: number }, ApiError, string>({
    mutationFn: (orderId) => request('POST', `/v1/orders/${orderId}/send-to-kitchen`, { tenantSlug: slug! }),
    onSuccess: (_d, orderId) => {
      qc.invalidateQueries({ queryKey: ['order', slug, orderId] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

export function useCancelOrder() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (orderId) => request('POST', `/v1/orders/${orderId}/cancel`, { tenantSlug: slug! }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['tables'] });
    },
  });
}

// =========================================================================
// Shifts / cash drawer (M10)
// =========================================================================

export type Shift = {
  id: string;
  opened_by_user_id: string;
  opened_by_email?: string | null;
  opened_at: string;
  opening_float_cents: number;
  closed_by_user_id?: string | null;
  closed_at?: string | null;
  closing_count_cents?: number | null;
  expected_cash_cents?: number | null;
  variance_cents?: number | null;
  notes: string;
  live_expected_cash_cents: number;
  live_cash_count_cents: number;
  /** payments(method=cash) + Σ cash_drops(direction=in) */
  live_cash_in_cents: number;
  /** Σ cash_drops(direction=out) */
  live_cash_out_cents: number;
};

// Cash drops — per-shift drawer ledger of cash moving in/out (0009).
export type CashDropDirection = 'out' | 'in';
export type CashDropKind =
  | 'owner_draw'
  | 'bank_deposit'
  | 'expense'
  | 'transfer'
  | 'paid_out'
  | 'paid_in'
  | 'petty_change'
  | 'correction'
  | 'other';

export type CashDrop = {
  id: string;
  shift_id: string;
  direction: CashDropDirection;
  kind: CashDropKind;
  amount_cents: number;
  reason: string;
  notes: string;
  expense_id?: string | null;
  expense_vendor?: string | null;
  recorded_by_user_id: string;
  recorded_by_email?: string | null;
  recorded_at: string;
};

export type CreateCashDropInput = {
  kind: CashDropKind;
  amount_cents: number;
  reason?: string;
  notes?: string;
  /** Only required when kind='correction' (other kinds infer direction). */
  direction?: CashDropDirection;
};

export function useCashDrops(shiftId: string | null | undefined) {
  const { slug } = useTenant();
  return useQuery<CashDrop[], ApiError>({
    queryKey: ['cash-drops', slug, shiftId],
    enabled: !!slug && !!shiftId,
    queryFn: () =>
      request<ListResp<'cash_drops', CashDrop>>(
        'GET',
        `/v1/shifts/${shiftId}/cash-drops`,
        { tenantSlug: slug! },
      ).then((r) => r.cash_drops),
  });
}

export function useCreateCashDrop(shiftId: string) {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<CashDrop, ApiError, CreateCashDropInput>({
    mutationFn: (body) =>
      request('POST', `/v1/shifts/${shiftId}/cash-drops`, { tenantSlug: slug!, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-drops', slug, shiftId] });
      qc.invalidateQueries({ queryKey: ['current-shift', slug] });
      qc.invalidateQueries({ queryKey: ['accounts-balances'] });
    },
  });
}

export function useDeleteCashDrop(shiftId: string) {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (dropId) =>
      request('DELETE', `/v1/shifts/${shiftId}/cash-drops/${dropId}`, { tenantSlug: slug! }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-drops', slug, shiftId] });
      qc.invalidateQueries({ queryKey: ['current-shift', slug] });
      qc.invalidateQueries({ queryKey: ['accounts-balances'] });
    },
  });
}

// Per-payment-method account balances + inter-account transfers (0009).
export type AccountBalance = {
  method: string;
  label: string;
  balance_cents: number;
  payments_cents: number;
  expenses_cents: number;
  transfers_in_cents: number;
  transfers_out_cents: number;
};

export type AccountTransfer = {
  id: string;
  from_method: string;
  to_method: string;
  amount_cents: number;
  fee_cents: number;
  reference_no: string;
  notes: string;
  transferred_at: string;
  shift_id?: string | null;
  cash_drop_id?: string | null;
  recorded_by_user_id: string;
  recorded_by_email?: string | null;
};

export type CreateTransferInput = {
  from_method: string;
  to_method: string;
  amount_cents: number;
  fee_cents?: number;
  reference_no?: string;
  notes?: string;
  transferred_at?: string;
};

export function useAccountBalances() {
  const { slug } = useTenant();
  return useQuery<AccountBalance[], ApiError>({
    queryKey: ['accounts-balances', slug],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'accounts', AccountBalance>>('GET', '/v1/accounts/balances', {
        tenantSlug: slug!,
      }).then((r) => r.accounts),
    refetchInterval: 30_000,
  });
}

export function useTransfers() {
  const { slug } = useTenant();
  return useQuery<AccountTransfer[], ApiError>({
    queryKey: ['transfers', slug],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'transfers', AccountTransfer>>('GET', '/v1/transfers', {
        tenantSlug: slug!,
      }).then((r) => r.transfers),
  });
}

export function useCreateTransfer() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<AccountTransfer, ApiError, CreateTransferInput>({
    mutationFn: (body) => request('POST', '/v1/transfers', { tenantSlug: slug!, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts-balances'] });
      qc.invalidateQueries({ queryKey: ['transfers'] });
      qc.invalidateQueries({ queryKey: ['current-shift', slug] });
      qc.invalidateQueries({ queryKey: ['cash-drops'] });
    },
  });
}

export function useDeleteTransfer() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => request('DELETE', `/v1/transfers/${id}`, { tenantSlug: slug! }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts-balances'] });
      qc.invalidateQueries({ queryKey: ['transfers'] });
      qc.invalidateQueries({ queryKey: ['current-shift', slug] });
      qc.invalidateQueries({ queryKey: ['cash-drops'] });
    },
  });
}

export function useCurrentShift() {
  const { slug } = useTenant();
  return useQuery<Shift | null, ApiError>({
    queryKey: ['current-shift', slug],
    enabled: !!slug,
    queryFn: () => request<Shift | null>('GET', '/v1/shifts/current', { tenantSlug: slug! }),
    refetchInterval: 30_000,
  });
}

export function useShifts() {
  const { slug } = useTenant();
  return useQuery<Shift[], ApiError>({
    queryKey: ['shifts', slug],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'shifts', Shift>>('GET', '/v1/shifts', { tenantSlug: slug! }).then((r) => r.shifts),
  });
}

export function useOpenShift() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<Shift, ApiError, { opening_float_cents: number; notes?: string }>({
    mutationFn: (body) => request('POST', '/v1/shifts/open', { tenantSlug: slug!, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['current-shift', slug] });
      qc.invalidateQueries({ queryKey: ['shifts', slug] });
    },
  });
}

export function useCloseShift() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    Shift,
    ApiError,
    { id: string; closing_count_cents: number; notes?: string }
  >({
    mutationFn: ({ id, ...body }) => request('POST', `/v1/shifts/${id}/close`, { tenantSlug: slug!, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['current-shift', slug] });
      qc.invalidateQueries({ queryKey: ['shifts', slug] });
    },
  });
}

// =========================================================================
// Reports (M8)
// =========================================================================

export type DashboardRange = 'today' | 'yesterday' | '7d' | '30d' | 'mtd' | 'ytd';
export type ProfitRange =
  | 'today'
  | 'yesterday'
  | 'dby'
  | 'thisweek'
  | 'mtd'
  | 'lastmonth'
  | 'ytd'
  | 'all'
  | 'custom';

export type DashboardKPIs = {
  sales_cents: number;
  tax_cents: number;
  service_cents: number;
  order_count: number;
  avg_ticket_cents: number;
  expenses_cents: number;
  net_cents: number;
  void_count: number;
  discount_cents: number;
};

export type DailyPoint = { day: string; sales_cents: number };

export type TopItemRow = {
  menu_item_id: string;
  name: string;
  category_name?: string | null;
  qty: number;
  revenue_cents: number;
};

export type ReportsDashboard = {
  range: string;
  from: string;
  to: string;
  timezone: string;
  kpis: DashboardKPIs;
  daily: DailyPoint[];
  top_sellers: TopItemRow[];
  slow_movers: TopItemRow[];
};

export function useReportsDashboard(range: DashboardRange = 'today') {
  const { slug } = useTenant();
  return useQuery<ReportsDashboard, ApiError>({
    queryKey: ['reports-dashboard', slug, range],
    enabled: !!slug,
    queryFn: () =>
      request<ReportsDashboard>('GET', `/v1/reports/dashboard?range=${range}`, { tenantSlug: slug! }),
    refetchInterval: 60_000, // pull a fresh snapshot every minute
  });
}

// =========================================================================
// Profitability (M9)
// =========================================================================

export type ProfitRow = {
  menu_category_id?: string | null;
  name: string;
  revenue_cents: number;
  /** Total COGS = direct + allocated. */
  cogs_cents: number;
  /** Sum of qty × unit_cost_cents on closed-order items. */
  direct_cogs_cents: number;
  /** Sum of expense_allocations.amount_cents in window. */
  allocated_cogs_cents: number;
  gross_profit_cents: number;
  margin_pct?: number | null;
};

export type ProfitReport = {
  range: string;
  from: string;
  to: string;
  timezone: string;
  categories: ProfitRow[];
  totals: ProfitRow;
  unallocated_cogs_cents: number;
};

export function useProfitability(range: ProfitRange, custom?: { from?: string; to?: string }) {
  const { slug } = useTenant();
  const qs = new URLSearchParams({ range });
  if (range === 'custom') {
    if (custom?.from) qs.set('from', custom.from);
    if (custom?.to) qs.set('to', custom.to);
  }
  return useQuery<ProfitReport, ApiError>({
    queryKey: ['profitability', slug, qs.toString()],
    enabled: !!slug && (range !== 'custom' || (!!custom?.from && !!custom?.to)),
    queryFn: () =>
      request<ProfitReport>('GET', `/v1/reports/profitability?${qs.toString()}`, { tenantSlug: slug! }),
  });
}

export type DrilldownExpense = {
  expense_id: string;
  paid_at: string;
  vendor: string;
  expense_amount_cents: number;
  share_pct: string;
  allocated_cents: number;
  notes: string;
};

export type DrilldownItem = {
  menu_item_id: string;
  name: string;
  qty: number;
  revenue_cents: number;
  cost_cents: number;
};

export type ProfitDrilldown = {
  range: string;
  from: string;
  to: string;
  category: ProfitRow;
  expenses: DrilldownExpense[];
  items: DrilldownItem[];
};

export function useProfitabilityDrilldown(
  categoryId: string | null,
  range: ProfitRange,
  custom?: { from?: string; to?: string },
) {
  const { slug } = useTenant();
  const qs = new URLSearchParams({ range });
  if (range === 'custom') {
    if (custom?.from) qs.set('from', custom.from);
    if (custom?.to) qs.set('to', custom.to);
  }
  return useQuery<ProfitDrilldown, ApiError>({
    queryKey: ['profitability-drilldown', slug, categoryId, qs.toString()],
    enabled: !!slug && !!categoryId,
    queryFn: () =>
      request<ProfitDrilldown>('GET', `/v1/reports/profitability/${categoryId}?${qs.toString()}`, {
        tenantSlug: slug!,
      }),
  });
}

// =========================================================================
// Expenses + cost-center allocations (M7)
// =========================================================================

export type ExpenseCategory = {
  id: string;
  name: string;
  color?: string | null;
  is_active: boolean;
};

export type ExpenseAllocation = {
  id: string;
  expense_id: string;
  menu_category_id: string;
  menu_category_name?: string | null;
  share_pct: string;
  amount_cents: number;
};

export type Expense = {
  id: string;
  expense_category_id?: string | null;
  expense_category_name?: string | null;
  vendor: string;
  amount_cents: number;
  paid_at: string;
  payment_method: string;
  reference_no: string;
  receipt_url?: string | null;
  notes: string;
  linked_inventory_item_id?: string | null;
  linked_inventory_name?: string | null;
  recorded_by_user_id: string;
  created_at: string;
  paid_from_drawer: boolean;
  shift_id?: string | null;
  allocations?: ExpenseAllocation[];
};

export type CreateExpenseInput = {
  expense_category_id?: string | null;
  vendor?: string;
  amount_cents: number;
  paid_at?: string;
  payment_method?: string;
  reference_no?: string;
  notes?: string;
  linked_inventory_item_id?: string | null;
  delta_units?: string;
  /** When true, the cash physically leaves the open shift's drawer. */
  paid_from_drawer?: boolean;
  allocations?: { menu_category_id: string; share_pct: string }[];
};

export function useExpenseCategories() {
  const { slug } = useTenant();
  return useQuery<ExpenseCategory[], ApiError>({
    queryKey: ['expense-categories', slug],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'categories', ExpenseCategory>>('GET', '/v1/expense-categories', {
        tenantSlug: slug!,
      }).then((r) => r.categories),
  });
}

export function useCreateExpenseCategory() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<ExpenseCategory, ApiError, { name: string; color?: string }>({
    mutationFn: (body) => request('POST', '/v1/expense-categories', { tenantSlug: slug!, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expense-categories'] }),
  });
}

export function useDeleteExpenseCategory() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => request('DELETE', `/v1/expense-categories/${id}`, { tenantSlug: slug! }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expense-categories'] }),
  });
}

export function useExpenses(params?: { from?: string; to?: string; expense_category_id?: string }) {
  const { slug } = useTenant();
  const qs = new URLSearchParams();
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  if (params?.expense_category_id) qs.set('expense_category_id', params.expense_category_id);
  const qsStr = qs.toString();
  return useQuery<Expense[], ApiError>({
    queryKey: ['expenses', slug, qsStr],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'expenses', Expense>>('GET', `/v1/expenses${qsStr ? '?' + qsStr : ''}`, {
        tenantSlug: slug!,
      }).then((r) => r.expenses),
  });
}

export function useCreateExpense() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<Expense, ApiError, CreateExpenseInput>({
    mutationFn: (body) => request('POST', '/v1/expenses', { tenantSlug: slug!, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['inventory-movements'] });
      qc.invalidateQueries({ queryKey: ['current-shift', slug] });
      qc.invalidateQueries({ queryKey: ['cash-drops'] });
      qc.invalidateQueries({ queryKey: ['accounts-balances'] });
    },
  });
}

export function useDeleteExpense() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => request('DELETE', `/v1/expenses/${id}`, { tenantSlug: slug! }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['current-shift', slug] });
      qc.invalidateQueries({ queryKey: ['cash-drops'] });
      qc.invalidateQueries({ queryKey: ['accounts-balances'] });
    },
  });
}

// =========================================================================
// Inventory (M6)
// =========================================================================

export type InventoryKind = 'retail' | 'ingredient';
export type StockReason = 'purchase' | 'sale' | 'waste' | 'adjust' | 'transfer';

export type InventoryItem = {
  id: string;
  name: string;
  sku?: string | null;
  kind: InventoryKind;
  sale_unit: string;
  qty_on_hand_units: string;
  par_low_units: string;
  last_purchase_unit_cost_cents?: number | null;
  notes: string;
  is_low_stock: boolean;
};

export type PackRule = {
  id: string;
  inventory_item_id: string;
  container_unit: string;
  container_qty: number;
  sale_unit: string;
  sale_qty_per_container: number;
  created_at: string;
};

export type StockMovement = {
  id: string;
  inventory_item_id: string;
  delta_units: string;
  reason: StockReason;
  ref_type?: string | null;
  ref_id?: string | null;
  unit_cost_cents?: number | null;
  notes: string;
  by_user_id?: string | null;
  at: string;
};

export type MenuItemInventoryLink = {
  menu_item_id: string;
  inventory_item_id: string;
  qty_consumed_per_sale: string;
};

export function useInventoryItems() {
  const { slug } = useTenant();
  return useQuery<InventoryItem[], ApiError>({
    queryKey: ['inventory', slug],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'items', InventoryItem>>('GET', '/v1/inventory', { tenantSlug: slug! }).then((r) => r.items),
  });
}

export function useCreateInventoryItem() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<InventoryItem, ApiError, Partial<InventoryItem>>({
    mutationFn: (body) => request('POST', '/v1/inventory', { tenantSlug: slug!, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

export function useUpdateInventoryItem() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<InventoryItem, ApiError, { id: string; patch: Partial<InventoryItem> }>({
    mutationFn: ({ id, patch }) => request('PATCH', `/v1/inventory/${id}`, { tenantSlug: slug!, body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

export function useDeleteInventoryItem() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => request('DELETE', `/v1/inventory/${id}`, { tenantSlug: slug! }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

export function useInventoryMovements(itemId?: string) {
  const { slug } = useTenant();
  return useQuery<StockMovement[], ApiError>({
    queryKey: ['inventory-movements', slug, itemId],
    enabled: !!slug && !!itemId,
    queryFn: () =>
      request<ListResp<'movements', StockMovement>>('GET', `/v1/inventory/${itemId}/movements`, {
        tenantSlug: slug!,
      }).then((r) => r.movements),
  });
}

export function useAdjustInventory() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    StockMovement,
    ApiError,
    { id: string; delta_units: string; reason: StockReason; notes: string; unit_cost_cents?: number }
  >({
    mutationFn: ({ id, ...body }) => request('POST', `/v1/inventory/${id}/adjust`, { tenantSlug: slug!, body }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['inventory-movements', slug, vars.id] });
    },
  });
}

export function usePackRules(itemId?: string) {
  const { slug } = useTenant();
  return useQuery<PackRule[], ApiError>({
    queryKey: ['pack-rules', slug, itemId],
    enabled: !!slug && !!itemId,
    queryFn: () =>
      request<ListResp<'pack_rules', PackRule>>('GET', `/v1/inventory/${itemId}/pack-rules`, {
        tenantSlug: slug!,
      }).then((r) => r.pack_rules),
  });
}

export function useCreatePackRule() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    PackRule,
    ApiError,
    { id: string; container_unit: string; container_qty: number; sale_unit: string; sale_qty_per_container: number }
  >({
    mutationFn: ({ id, ...body }) =>
      request('POST', `/v1/inventory/${id}/pack-rules`, { tenantSlug: slug!, body }),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ['pack-rules', slug, vars.id] }),
  });
}

export function useDeletePackRule() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, { itemId: string; ruleId: string }>({
    mutationFn: ({ itemId, ruleId }) =>
      request('DELETE', `/v1/inventory/${itemId}/pack-rules/${ruleId}`, { tenantSlug: slug! }),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ['pack-rules', slug, vars.itemId] }),
  });
}

export function useMenuItemLink(menuItemId?: string) {
  const { slug } = useTenant();
  return useQuery<MenuItemInventoryLink | null, ApiError>({
    queryKey: ['menu-item-link', slug, menuItemId],
    enabled: !!slug && !!menuItemId,
    queryFn: () =>
      request<MenuItemInventoryLink | null>('GET', `/v1/menu/items/${menuItemId}/inventory-link`, {
        tenantSlug: slug!,
      }),
  });
}

export function usePutMenuItemLink() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    MenuItemInventoryLink | void,
    ApiError,
    { menuItemId: string; inventory_item_id: string | null; qty_consumed_per_sale?: string }
  >({
    mutationFn: ({ menuItemId, ...body }) =>
      request('PUT', `/v1/menu/items/${menuItemId}/inventory-link`, { tenantSlug: slug!, body }),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ['menu-item-link', slug, vars.menuItemId] }),
  });
}

// =========================================================================
// Payments + close
// =========================================================================

export type PaymentMethod = 'cash' | 'esewa' | 'khalti' | 'card' | 'other' | 'house_tab';

export type Payment = {
  id: string;
  order_id: string;
  method: PaymentMethod;
  amount_cents: number;
  reference_no: string;
  house_tab_id?: string | null;
  house_tab_name?: string | null;
  recorded_by_user_id: string;
  recorded_at: string;
};

export type SettleQuote = {
  subtotal_cents: number;
  discount_cents: number;
  service_charge_cents: number;
  tax_cents: number;
  total_cents: number;
  paid_cents: number;
  balance_cents: number;
  service_charge_pct: string;
  vat_pct: string;
};

export function useSettleQuote(orderId?: string) {
  const { slug } = useTenant();
  return useQuery<SettleQuote, ApiError>({
    queryKey: ['order-quote', slug, orderId],
    enabled: !!slug && !!orderId,
    queryFn: () => request<SettleQuote>('GET', `/v1/orders/${orderId}/quote`, { tenantSlug: slug! }),
  });
}

export function useOrderPayments(orderId?: string) {
  const { slug } = useTenant();
  return useQuery<Payment[], ApiError>({
    queryKey: ['order-payments', slug, orderId],
    enabled: !!slug && !!orderId,
    queryFn: () =>
      request<ListResp<'payments', Payment>>('GET', `/v1/orders/${orderId}/payments`, {
        tenantSlug: slug!,
      }).then((r) => r.payments),
  });
}

export function useRecordPayment() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    Payment,
    ApiError,
    {
      orderId: string;
      method: PaymentMethod;
      amount_cents: number;
      reference_no?: string;
      house_tab_id?: string;
    }
  >({
    mutationFn: ({ orderId, ...body }) =>
      request('POST', `/v1/orders/${orderId}/payments`, { tenantSlug: slug!, body }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['order-payments', slug, vars.orderId] });
      qc.invalidateQueries({ queryKey: ['order-quote', slug, vars.orderId] });
      if (vars.method === 'house_tab') {
        qc.invalidateQueries({ queryKey: ['house-tabs'] });
      }
    },
  });
}

export function useDeletePayment() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, { orderId: string; paymentId: string }>({
    mutationFn: ({ orderId, paymentId }) =>
      request('DELETE', `/v1/orders/${orderId}/payments/${paymentId}`, { tenantSlug: slug! }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['order-payments', slug, vars.orderId] });
      qc.invalidateQueries({ queryKey: ['order-quote', slug, vars.orderId] });
    },
  });
}

export function useCloseOrder() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<SettleQuote, ApiError, string>({
    mutationFn: (orderId) => request('POST', `/v1/orders/${orderId}/close`, { tenantSlug: slug! }),
    onSuccess: (_d, orderId) => {
      qc.invalidateQueries({ queryKey: ['order', slug, orderId] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['tables'] });
    },
  });
}

// =========================================================================
// Kitchen / KDS
// =========================================================================

export type KitchenTicket = {
  item_id: string;
  order_id: string;
  service_table_name?: string | null;
  menu_item_name: string;
  qty: number;
  modifiers: unknown;
  notes: string;
  kitchen_status: 'in_progress' | 'ready';
  sent_to_kitchen_at?: string | null;
  ready_at?: string | null;
};

export function useKitchenTickets() {
  const { slug } = useTenant();
  return useQuery<KitchenTicket[], ApiError>({
    queryKey: ['kitchen-tickets', slug],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'tickets', KitchenTicket>>('GET', '/v1/kitchen/tickets', {
        tenantSlug: slug!,
      }).then((r) => r.tickets),
  });
}

export function useUpdateKitchenTicket() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, { itemId: string; kitchen_status: 'ready' | 'served' }>({
    mutationFn: ({ itemId, kitchen_status }) =>
      request('PATCH', `/v1/kitchen/tickets/${itemId}`, {
        tenantSlug: slug!,
        body: { kitchen_status },
      }),
    // Optimistic invalidation; the WS event from the server will also
    // invalidate, but doing it here keeps the click-to-update snappy.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kitchen-tickets', slug] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

// =========================================================================
// Members (multi-role)
// =========================================================================

export type Member = {
  user_id: string;
  email: string;
  name: string;
  roles: TenantRole[];
  status: 'active' | 'pending' | 'suspended';
};

export function useMembers() {
  const { slug } = useTenant();
  return useQuery<Member[], ApiError>({
    queryKey: ['members', slug],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'members', Member>>('GET', '/v1/members', { tenantSlug: slug! }).then(
        (r) => r.members,
      ),
  });
}

// =========================================================================
// Invites (pre-membership; auto-accepted at login)
// =========================================================================

export type Invite = {
  id: string;
  email: string;
  roles: TenantRole[];
  invited_at: string;
  invited_by_user_id?: string | null;
};

export function useInvites() {
  const { slug } = useTenant();
  return useQuery<Invite[], ApiError>({
    queryKey: ['invites', slug],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'invites', Invite>>('GET', '/v1/invites', { tenantSlug: slug! }).then(
        (r) => r.invites,
      ),
  });
}

export function useCreateInvite() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<Invite, ApiError, { email: string; roles: TenantRole[] }>({
    mutationFn: (body) => request('POST', '/v1/invites', { tenantSlug: slug!, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invites', slug] }),
  });
}

export function useRevokeInvite() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => request('DELETE', `/v1/invites/${id}`, { tenantSlug: slug! }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invites', slug] }),
  });
}

export function useUpdateMemberRoles() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, { userId: string; roles: TenantRole[] }>({
    mutationFn: ({ userId, roles }) =>
      request('PATCH', `/v1/members/${userId}/roles`, {
        tenantSlug: slug!,
        body: { roles },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['members', slug] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

// =========================================================================
// House tabs (stakeholder running ledgers)
// =========================================================================

export type HouseTab = {
  id: string;
  name: string;
  notes: string;
  is_active: boolean;
  charged_cents: number;
  settled_cents: number;
  balance_cents: number;
  open_charge_count: number;
  created_at: string;
  archived_at?: string | null;
};

export type HouseTabCharge = {
  payment_id: string;
  order_id: string;
  service_table_name?: string | null;
  amount_cents: number;
  reference_no: string;
  recorded_at: string;
};

export type HouseTabSettlement = {
  id: string;
  amount_cents: number;
  payment_method: PaymentMethod;
  reference_no: string;
  notes: string;
  recorded_at: string;
};

export type HouseTabDetail = {
  house_tab: HouseTab;
  charges: HouseTabCharge[];
  settlements: HouseTabSettlement[];
};

export function useHouseTabs() {
  const { slug } = useTenant();
  return useQuery<HouseTab[], ApiError>({
    queryKey: ['house-tabs', slug],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'house_tabs', HouseTab>>('GET', '/v1/house-tabs', { tenantSlug: slug! }).then(
        (r) => r.house_tabs,
      ),
  });
}

export function useHouseTab(id: string | null) {
  const { slug } = useTenant();
  return useQuery<HouseTabDetail, ApiError>({
    queryKey: ['house-tab', slug, id],
    enabled: !!slug && !!id,
    queryFn: () =>
      request<HouseTabDetail>('GET', `/v1/house-tabs/${id}`, { tenantSlug: slug! }),
  });
}

export function useCreateHouseTab() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<HouseTab, ApiError, { name: string; notes?: string }>({
    mutationFn: (body) => request('POST', '/v1/house-tabs', { tenantSlug: slug!, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['house-tabs', slug] }),
  });
}

export function useUpdateHouseTab() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<HouseTab, ApiError, { id: string; patch: { name?: string; notes?: string; is_active?: boolean } }>({
    mutationFn: ({ id, patch }) =>
      request('PATCH', `/v1/house-tabs/${id}`, { tenantSlug: slug!, body: patch }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['house-tabs', slug] });
      qc.invalidateQueries({ queryKey: ['house-tab', slug, vars.id] });
    },
  });
}

export function useDeleteHouseTab() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => request('DELETE', `/v1/house-tabs/${id}`, { tenantSlug: slug! }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['house-tabs', slug] }),
  });
}

export function useCreateHouseTabSettlement() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    HouseTabSettlement,
    ApiError,
    { id: string; amount_cents: number; payment_method: PaymentMethod | 'online'; reference_no?: string; notes?: string }
  >({
    mutationFn: ({ id, ...body }) =>
      request('POST', `/v1/house-tabs/${id}/settlements`, { tenantSlug: slug!, body }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['house-tabs', slug] });
      qc.invalidateQueries({ queryKey: ['house-tab', slug, vars.id] });
    },
  });
}

export type CreatedTenant = {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  roles: TenantRole[];
};

export function useCreateTenant() {
  const qc = useQueryClient();
  return useMutation<CreatedTenant, ApiError, { name: string; slug?: string; timezone?: string }>({
    mutationFn: (body) => request('POST', '/v1/tenants', { body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

export function useSelectTenant() {
  const qc = useQueryClient();
  return useMutation<{ tenant_slug: string; roles: TenantRole[] }, ApiError, string>({
    mutationFn: (tenantSlug) =>
      request('POST', '/v1/sessions/select-tenant', {
        tenantSlug,
        body: { tenant_slug: tenantSlug },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });
}

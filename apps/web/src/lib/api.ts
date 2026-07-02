// Typed API client + TanStack Query hooks for the GoServe API.
//
// Auth: JWT bearer tokens (see lib/auth-store.ts). Every request carries an
// `Authorization: Bearer <access token>` header. On a 401 we transparently
// rotate the refresh token once and retry, so callers never see token expiry.
//
// URL strategy:
//   - In dev, VITE_API_BASE_URL is empty. Paths like `/v1/...` are relative,
//     and the Vite proxy (vite.config.ts) forwards them to the API.
//   - In prod, set VITE_API_BASE_URL to the API origin, e.g.
//     `https://api.cafe.example.com`. The client builds absolute URLs; auth
//     is the bearer header, so cross-site cookies (blocked on iOS) aren't used.
//
// Tenant scope is sent via the X-Tenant-ID header.

import { useEffect } from 'react';
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { UseQueryOptions, UseMutationOptions, QueryClient } from '@tanstack/react-query';

import { useTenant } from './tenant';
import { getAccessToken, getRefreshToken, setTokens, clearTokens, useAuthStore } from './auth-store';
import { markSynced, markOffline, isOffline, subscribeConnectivity } from './connectivity';
import {
  enqueueOp,
  removeOp,
  setOpStatus,
  getQueuedOps,
  type QueuedOp,
  type QueuedAddPayload,
  type QueuedUpdatePayload,
  type QueuedVoidPayload,
} from './offline-queue';

// -------------------------------------------------------------------------
// Shared DTOs + pure helpers now live in @cafe-mgmt/api-types (so apps/mobile
// can share them). Imported for this module's own use AND re-exported verbatim
// to preserve its public surface — existing `import { X } from '.../lib/api'`
// sites are untouched.
// -------------------------------------------------------------------------
import type {
  AccountBalance,
  AccountTransfer,
  AddOrderItemsVars,
  AdjustmentType,
  AdminBugAttachment,
  AdminBugReport,
  AdminBugReportDetail,
  AdminBugReportsResponse,
  AdminPayment,
  AdminPlan,
  AdminTenant,
  AdminTenantDetail,
  AdminTenantRequest,
  AdminTenantsResponse,
  ApiError,
  AuditActor,
  AuditEvent,
  AuditFilters,
  AuthConfig,
  BillingInfo,
  BugKind,
  BugPriority,
  BugReportFilters,
  BugReportInput,
  BugStatus,
  BulkImportCounts,
  BulkImportPayload,
  BulkImportResult,
  CafeBalance,
  CafeOwner,
  CafeSummary,
  CashDrop,
  CashDropDirection,
  CashDropKind,
  CategoryMixRow,
  CreateCashDropInput,
  CreateExpenseInput,
  CreateTransferInput,
  DailyPoint,
  DashboardCustom,
  DashboardKPIs,
  DashboardRange,
  DrilldownExpense,
  DrilldownItem,
  Expense,
  ExpenseAllocation,
  ExpenseCategory,
  ExpensePaidFrom,
  FeatureDef,
  HeatmapCell,
  HeatmapResp,
  HistoryOrder,
  HistoryPayment,
  HourlyBucket,
  HourlyResp,
  HouseTab,
  HouseTabCharge,
  HouseTabDetail,
  HouseTabSettlement,
  InventoryItem,
  InventoryKind,
  Invite,
  KitchenBehavior,
  KitchenStatus,
  KitchenTicket,
  Me,
  Member,
  Membership,
  MenuCategory,
  MenuItem,
  MenuItemInventoryLink,
  MoodKey,
  MyBugReport,
  Order,
  OrderAdjustment,
  OrderHistoryResp,
  OrderItemRow,
  OrderStatus,
  OwnerCashEntry,
  OwnerCashHolding,
  OwnerCashKind,
  OwnerCashResponse,
  OwnerLedgerEntry,
  OwnerLedgerKind,
  PackRule,
  Payment,
  PaymentMethod,
  PaymentMix,
  PayoutEntryInput,
  PermissionDef,
  PermissionManifest,
  PlanInput,
  PlatformAdminEntry,
  PrinterConn,
  PrintWidth,
  PlatformAuditEvent,
  PopularMenuItem,
  ProfitDrilldown,
  ProfitRange,
  ProfitReport,
  ProfitRow,
  PurgeScope,
  RecordPaymentInput,
  ReportsDashboard,
  RequestOTPResponse,
  ResourceDef,
  Role,
  SalaryCadence,
  ServiceTable,
  SettleQuote,
  Shift,
  ShiftPayment,
  Staff,
  StaffDetail,
  StaffDocument,
  StaffInput,
  StaffPay,
  StaffPayInput,
  StaffSchedule,
  StockMovement,
  StockReason,
  SystemRoleDef,
  TabBreakdownRow,
  TabState,
  TableMixRow,
  TenantBranding,
  TenantDataSummary,
  TenantPreferences,
  TenantRole,
  TenantSettings,
  TokenResponse,
  TopItemRow,
  TopSellerRow,
  TopSellersResp,
  TrialState,
  TypographyKey,
  UpdateExpenseInput,
  VatMode,
  VelocityPoint,
  VelocityResp,
  WriteLockState,
} from '@cafe-mgmt/api-types';
import {
  deriveTabState,
  resolveKitchenBehavior,
  resolveTableLabel,
  tenantDefaultKitchenBehavior,
} from '@cafe-mgmt/api-types';

// Re-export the shared symbols so downstream `import { X } from '.../lib/api'`
// keeps resolving exactly as before.
export type {
  AccountBalance,
  AccountTransfer,
  AddOrderItemsVars,
  AdjustmentType,
  AdminBugAttachment,
  AdminBugReport,
  AdminBugReportDetail,
  AdminBugReportsResponse,
  AdminPayment,
  AdminPlan,
  AdminTenant,
  AdminTenantDetail,
  AdminTenantRequest,
  AdminTenantsResponse,
  ApiError,
  AuditActor,
  AuditEvent,
  AuditFilters,
  AuthConfig,
  BillingInfo,
  BugKind,
  BugPriority,
  BugReportFilters,
  BugReportInput,
  BugStatus,
  BulkImportCounts,
  BulkImportPayload,
  BulkImportResult,
  CafeBalance,
  CafeOwner,
  CafeSummary,
  CashDrop,
  CashDropDirection,
  CashDropKind,
  CategoryMixRow,
  CreateCashDropInput,
  CreateExpenseInput,
  CreateTransferInput,
  DailyPoint,
  DashboardCustom,
  DashboardKPIs,
  DashboardRange,
  DrilldownExpense,
  DrilldownItem,
  Expense,
  ExpenseAllocation,
  ExpenseCategory,
  ExpensePaidFrom,
  FeatureDef,
  HeatmapCell,
  HeatmapResp,
  HistoryOrder,
  HistoryPayment,
  HourlyBucket,
  HourlyResp,
  HouseTab,
  HouseTabCharge,
  HouseTabDetail,
  HouseTabSettlement,
  InventoryItem,
  InventoryKind,
  Invite,
  KitchenBehavior,
  KitchenStatus,
  KitchenTicket,
  Me,
  Member,
  Membership,
  MenuCategory,
  MenuItem,
  MenuItemInventoryLink,
  MoodKey,
  MyBugReport,
  Order,
  OrderAdjustment,
  OrderHistoryResp,
  OrderItemRow,
  OrderStatus,
  OwnerCashEntry,
  OwnerCashHolding,
  OwnerCashKind,
  OwnerCashResponse,
  OwnerLedgerEntry,
  OwnerLedgerKind,
  PackRule,
  Payment,
  PaymentMethod,
  PaymentMix,
  PayoutEntryInput,
  PermissionDef,
  PermissionManifest,
  PlanInput,
  PlatformAdminEntry,
  PrinterConn,
  PrintWidth,
  PlatformAuditEvent,
  PopularMenuItem,
  ProfitDrilldown,
  ProfitRange,
  ProfitReport,
  ProfitRow,
  PurgeScope,
  RecordPaymentInput,
  ReportsDashboard,
  RequestOTPResponse,
  ResourceDef,
  Role,
  SalaryCadence,
  ServiceTable,
  SettleQuote,
  Shift,
  ShiftPayment,
  Staff,
  StaffDetail,
  StaffDocument,
  StaffInput,
  StaffPay,
  StaffPayInput,
  StaffSchedule,
  StockMovement,
  StockReason,
  SystemRoleDef,
  TabBreakdownRow,
  TabState,
  TableMixRow,
  TenantBranding,
  TenantDataSummary,
  TenantPreferences,
  TenantRole,
  TenantSettings,
  TokenResponse,
  TopItemRow,
  TopSellerRow,
  TopSellersResp,
  TrialState,
  TypographyKey,
  UpdateExpenseInput,
  VatMode,
  VelocityPoint,
  VelocityResp,
  WriteLockState,
};
export {
  deriveTabState,
  resolveKitchenBehavior,
  resolveTableLabel,
  tenantDefaultKitchenBehavior,
};



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

// One-shot: refresh token was rejected — clear auth and bounce to login.
let unauthedHandled = false;
function handleUnauthenticated() {
  if (unauthedHandled) return;
  unauthedHandled = true;
  clearTokens();
  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.replace('/login');
  }
}

// Single-flight refresh: concurrent 401s share one /auth/refresh call so we
// don't rotate the refresh token N times (which would trip reuse detection).
//
// Tri-state result — the distinction is load-bearing for offline support:
//   'ok'      — rotated, retry the original request
//   'invalid' — the server REJECTED the refresh token (401/403): session is
//               truly dead, clear tokens and go to /login
//   'network' — the refresh never reached the server (offline, 5xx). The
//               session may be perfectly valid; keep the tokens and let the
//               caller surface a network error. Logging the cashier out for
//               a wifi blip mid-shift would lose their working state.
type RefreshResult = 'ok' | 'invalid' | 'network';
let refreshPromise: Promise<RefreshResult> | null = null;
function refreshTokens(): Promise<RefreshResult> {
  if (refreshPromise) return refreshPromise;
  const rt = getRefreshToken();
  if (!rt) return Promise.resolve('invalid');
  refreshPromise = (async (): Promise<RefreshResult> => {
    try {
      const res = await fetch(url('/auth/refresh'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      });
      if (res.status === 401 || res.status === 403) return 'invalid';
      if (!res.ok) return 'network';
      const j = (await res.json()) as TokenResponse;
      setTokens(j.access_token, j.refresh_token);
      return 'ok';
    } catch {
      markOffline();
      return 'network';
    }
  })().finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}

// Proactive refresh: decode the access token's `exp` and refresh ~60s before it
// expires, so an idle tab never lands on a 401 (and the reuse-detection retry
// dance that can follow). Reactive 401 refresh still covers anything this
// misses. Rescheduled on every token change via the store subscription below.
let proactiveTimer: ReturnType<typeof setTimeout> | null = null;
function decodeJwtExpMs(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { exp?: number };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}
function scheduleProactiveRefresh(): void {
  if (proactiveTimer) {
    clearTimeout(proactiveTimer);
    proactiveTimer = null;
  }
  const at = getAccessToken();
  if (!at || !getRefreshToken()) return; // logged out — nothing to keep warm
  const expMs = decodeJwtExpMs(at);
  if (expMs == null) return;
  // Fire 60s before expiry; never less than 5s out (avoid a tight loop right
  // after a refresh) and cap the timer so a far-future exp can't overflow it.
  const delay = Math.min(Math.max(expMs - Date.now() - 60_000, 5_000), 0x7fffffff);
  proactiveTimer = setTimeout(() => {
    void refreshTokens().finally(scheduleProactiveRefresh);
  }, delay);
}
// Reschedule on login / exchange / OTP / refresh / logout — any token change.
useAuthStore.subscribe(scheduleProactiveRefresh);
// And once now, for a token restored from localStorage on boot.
scheduleProactiveRefresh();

// Heal-on-return: setTimeout is frozen while a tab is backgrounded (aggressively
// so on iOS), so the proactive timer above never fires for a suspended app and
// the access token silently expires. When the tab becomes visible again, refresh
// up front if the token is already gone or within the proactive window — before
// the user's navigation fires requests that would otherwise 401. Single-flight in
// refreshTokens() keeps this from racing the reactive 401 path.
function refreshOnReturn(): void {
  const at = getAccessToken();
  if (!getRefreshToken()) return; // logged out — nothing to refresh
  const expMs = at ? decodeJwtExpMs(at) : null;
  // No access token, undecodable, or expiring within 60s → refresh now.
  if (expMs == null || expMs - Date.now() < 60_000) {
    void refreshTokens().finally(scheduleProactiveRefresh);
  } else {
    // Token still fresh, but the timer may have been throttled — re-arm it.
    scheduleProactiveRefresh();
  }
}
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshOnReturn();
  });
}
if (typeof window !== 'undefined') {
  window.addEventListener('focus', refreshOnReturn);
}

async function request<T>(
  method: string,
  path: string,
  opts: { tenantSlug?: string; body?: unknown } = {},
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.tenantSlug) headers['X-Tenant-ID'] = opts.tenantSlug;
  const accessToken = getAccessToken();
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  let res: Response;
  try {
    res = await fetch(url(path), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    // fetch only throws when the request never completed (no network, DNS,
    // CORS catastrophes). Surface a synthetic status-0 ApiError so callers —
    // and the offline queue — can tell "offline" apart from a server error.
    markOffline();
    const err: ApiError = { status: 0, code: 'network', message: 'You appear to be offline.' };
    throw err;
  }
  markSynced();

  // Transparent refresh-on-401: rotate once and retry. Skip for /auth/* (the
  // refresh/login endpoints themselves) and when we've already retried.
  // Only a server-side REJECTION of the refresh token logs the user out — a
  // network failure during refresh keeps the session for when we're back.
  if (res.status === 401 && !retried && !path.startsWith('/auth/')) {
    if (getRefreshToken()) {
      const result = await refreshTokens();
      if (result === 'ok') return request<T>(method, path, opts, true);
      if (result === 'invalid') handleUnauthenticated();
    }
  }

  if (!res.ok) {
    let message = res.statusText;
    let code: string | undefined;
    let retryAfter: number | undefined;
    let attemptsRemaining: number | undefined;
    let workspaces: string[] | undefined;
    try {
      const j = (await res.json()) as {
        message?: string;
        code?: string;
        retry_after_seconds?: number;
        attempts_remaining?: number;
        workspaces?: string[];
      };
      if (j.message) message = j.message;
      code = j.code;
      retryAfter = j.retry_after_seconds;
      attemptsRemaining = j.attempts_remaining;
      workspaces = j.workspaces;
    } catch {
      /* ignore */
    }
    // Fall back to the standard Retry-After header when a 429 body didn't
    // carry the hint (e.g. an upstream proxy or a limiter we don't control).
    if (retryAfter === undefined && res.status === 429) {
      const h = res.headers.get('Retry-After');
      const n = h ? parseInt(h, 10) : NaN;
      if (!Number.isNaN(n)) retryAfter = n;
    }
    const err: ApiError = {
      status: res.status,
      message,
      code,
      retry_after_seconds: retryAfter,
      attempts_remaining: attemptsRemaining,
      workspaces,
    };
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

import { matches, type Permission } from '@cafe-mgmt/rbac';





/** True if the user is a site-wide super admin. */
export function isPlatformAdmin(me: Me | undefined): boolean {
  return !!me?.is_platform_admin;
}

/** True if the active tenant's plan includes `feature`. */
export function hasFeature(me: Me | undefined, feature: string): boolean {
  return !!me?.billing?.features?.includes(feature);
}

/** True if the active membership has been granted `want`. Reads from `active_permissions`. */
export function can(me: Me | undefined, want: Permission): boolean {
  if (!me?.active_permissions) return false;
  return matches(me.active_permissions, want);
}

/** True if the active membership has been granted at least one of `wants`. */
export function canAny(me: Me | undefined, ...wants: Permission[]): boolean {
  if (!me?.active_permissions) return false;
  return wants.some((w) => matches(me.active_permissions!, w));
}

/** Convenience: True if the active membership holds the system 'owner' role. */
export function isSystemOwner(me: Me | undefined): boolean {
  return !!(me?.active_role_keys ?? me?.active_roles ?? []).includes('owner');
}

/**
 * Legacy helpers retained so existing call sites stay compilable during the
 * RBAC migration. New code should call `can(perm)` instead. These check
 * role keys, which still works for the 4 system roles.
 */
export function hasRole(me: Me | undefined, want: TenantRole): boolean {
  return !!(me?.active_role_keys ?? me?.active_roles ?? []).includes(want);
}
export function hasAnyRole(me: Me | undefined, ...wants: TenantRole[]): boolean {
  const have = me?.active_role_keys ?? me?.active_roles ?? [];
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
  return useMutation<TokenResponse, ApiError, { email: string; name?: string }>({
    mutationFn: (vars) => request('POST', '/auth/dev-login', { body: vars }),
    onSuccess: (data) => {
      setTokens(data.access_token, data.refresh_token);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

/** Exchange the one-time Google handoff code (from /auth/callback) for tokens. */
export function useExchangeCode() {
  const qc = useQueryClient();
  return useMutation<TokenResponse, ApiError, { code: string }>({
    mutationFn: (vars) => request('POST', '/auth/exchange', { body: vars }),
    onSuccess: (data) => {
      setTokens(data.access_token, data.refresh_token);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean }, ApiError>({
    mutationFn: () => request('POST', '/auth/logout', { body: { refresh_token: getRefreshToken() } }),
    // Clear local auth regardless of the server response — the user intends
    // to be logged out either way.
    onSettled: () => {
      clearTokens();
      qc.clear();
    },
  });
}

/** Fetch a single-use WebSocket ticket for the active tenant (lib/ws.ts). */
export function getWSTicket(slug: string): Promise<{ ticket: string }> {
  return request<{ ticket: string }>('POST', '/v1/ws-ticket', { tenantSlug: slug });
}

/** GDPR — trigger a personal-data download. The endpoint streams a JSON
 *  attachment, so we fetch it as a Blob and let the browser save it. */
export function useExportMyData() {
  return useMutation<void, ApiError>({
    mutationFn: async () => {
      const url = API_BASE ? `${API_BASE}/v1/me/export` : '/v1/me/export';
      const at = getAccessToken();
      const r = await fetch(url, { headers: at ? { Authorization: `Bearer ${at}` } : {} });
      if (!r.ok) {
        let msg = `HTTP ${r.status}`;
        try {
          const body = (await r.json()) as { message?: string };
          if (body?.message) msg = body.message;
        } catch { /* non-JSON error */ }
        const err: ApiError = { status: r.status, message: msg };
        throw err;
      }
      const blob = await r.blob();
      const disp = r.headers.get('Content-Disposition') ?? '';
      const m = disp.match(/filename="([^"]+)"/);
      const filename = m?.[1] ?? `cafe-mgmt-export-${new Date().toISOString().slice(0, 10)}.json`;
      const link = document.createElement('a');
      const objectUrl = URL.createObjectURL(blob);
      link.href = objectUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    },
  });
}

/** GDPR — irrevocably delete the current user. The server soft-deletes,
 *  anonymizes, and revokes sessions. The client should redirect to /login. */
export function useDeleteMyAccount() {
  const qc = useQueryClient();
  return useMutation<{ deleted: boolean }, ApiError>({
    mutationFn: () => request('DELETE', '/v1/me'),
    onSuccess: () => {
      clearTokens();
      qc.clear();
    },
  });
}


export function useRequestOTP() {
  return useMutation<RequestOTPResponse, ApiError, { email: string }>({
    mutationFn: (vars) => request('POST', '/auth/request-otp', { body: vars }),
  });
}

export function useVerifyOTP() {
  const qc = useQueryClient();
  return useMutation<TokenResponse, ApiError, { email: string; code: string }>({
    mutationFn: (vars) => request('POST', '/auth/verify-otp', { body: vars }),
    onSuccess: (data) => {
      setTokens(data.access_token, data.refresh_token);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

// =========================================================================
// Menu categories
// =========================================================================



type ListResp<K extends string, T> = { [P in K]: T[] };

export function useMenuCategories() {
  const { slug } = useTenant();
  return useQuery<MenuCategory[], ApiError>({
    queryKey: ['menu-categories', slug],
    enabled: !!slug,
    // Categories drive the tab strip + item grouping on the order page; they
    // are reference data the page can't render correctly without. A categories
    // fetch that ran before the tenant RLS context was aligned (e.g. during the
    // JWT/tenant handoff) returns an empty list with a 200, which then sticks in
    // cache for the 30s default staleTime. Revalidate on every mount so the
    // order page never gets stuck showing ungrouped items with no tabs.
    refetchOnMount: 'always',
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['menu-items'] });
      qc.invalidateQueries({ queryKey: ['menu-popular'] });
    },
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
// Bulk menu import — one transactional upsert of categories + items, matched
// by name (categories by name, items by category+name). See lib/menuImport.ts
// for the JSON contract and the ChatGPT prompt that produces it.
// =========================================================================



export function useBulkImportMenu() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<BulkImportResult, ApiError, BulkImportPayload>({
    mutationFn: (body) => request('POST', '/v1/menu/import', { tenantSlug: slug!, body }),
    onSuccess: (res) => {
      // A dry-run mutates nothing — only refresh caches on a real import.
      if (res.dry_run) return;
      qc.invalidateQueries({ queryKey: ['menu-categories'] });
      qc.invalidateQueries({ queryKey: ['menu-items'] });
      qc.invalidateQueries({ queryKey: ['menu-popular'] });
    },
  });
}

/** Upload a catalog image (category banner or item photo). Returns the stored
 *  object URL; the caller persists it onto the category/item via create/update.
 *  Multipart, so it bypasses `request()` (which is JSON-only) like the logo
 *  upload does. */
export function useUploadMenuImage() {
  const { slug } = useTenant();
  return useMutation<{ url: string }, ApiError, File>({
    mutationFn: async (file) => {
      const fd = new FormData();
      fd.append('file', file);
      const at = getAccessToken();
      const res = await fetch(url('/v1/menu/images'), {
        method: 'POST',
        headers: {
          'X-Tenant-ID': slug!,
          ...(at ? { Authorization: `Bearer ${at}` } : {}),
        },
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
      return (await res.json()) as { url: string };
    },
  });
}

// =========================================================================
// Staff management (0023)
//
// Staff are standalone employee records (not login members). Their documents
// are sensitive personal IDs: stored privately and only fetched through the
// authenticated /file endpoint (gated server-side by staff:read), never via a
// public URL. fetchStaffDocBlob streams those bytes into an object URL.
// =========================================================================









export function useStaffList() {
  const { slug } = useTenant();
  return useQuery<Staff[], ApiError>({
    queryKey: ['staff', slug],
    enabled: !!slug,
    queryFn: () =>
      request<{ staff: Staff[] }>('GET', '/v1/staff', { tenantSlug: slug! }).then((r) => r.staff),
  });
}

export function useStaff(id: string | undefined) {
  const { slug } = useTenant();
  return useQuery<StaffDetail, ApiError>({
    queryKey: ['staff', slug, id],
    enabled: !!slug && !!id,
    queryFn: () => request<StaffDetail>('GET', `/v1/staff/${id}`, { tenantSlug: slug! }),
  });
}

export function useCreateStaff() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<Staff, ApiError, StaffInput>({
    mutationFn: (body) => request<Staff>('POST', '/v1/staff', { tenantSlug: slug!, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff', slug] }),
  });
}

export function useUpdateStaff(id: string) {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<Staff, ApiError, Partial<StaffInput>>({
    mutationFn: (body) => request<Staff>('PATCH', `/v1/staff/${id}`, { tenantSlug: slug!, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['staff', slug] });
      qc.invalidateQueries({ queryKey: ['staff', slug, id] });
    },
  });
}

export function useDeleteStaff() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => request('DELETE', `/v1/staff/${id}`, { tenantSlug: slug! }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff', slug] }),
  });
}

export function useUploadStaffDocument(staffId: string) {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<StaffDocument, ApiError, { file: File; docType: string; label?: string }>({
    mutationFn: async ({ file, docType, label }) => {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('doc_type', docType);
      if (label) fd.append('label', label);
      const at = getAccessToken();
      const res = await fetch(url(`/v1/staff/${staffId}/documents`), {
        method: 'POST',
        headers: { 'X-Tenant-ID': slug!, ...(at ? { Authorization: `Bearer ${at}` } : {}) },
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
      return (await res.json()) as StaffDocument;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['staff', slug, staffId] });
      qc.invalidateQueries({ queryKey: ['staff', slug] });
    },
  });
}

export function useDeleteStaffDocument(staffId: string) {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (docId) =>
      request('DELETE', `/v1/staff/${staffId}/documents/${docId}`, { tenantSlug: slug! }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['staff', slug, staffId] });
      qc.invalidateQueries({ queryKey: ['staff', slug] });
    },
  });
}

// Salary pay-history ledger (0033).

export function useStaffPay(staffId: string | undefined) {
  const { slug } = useTenant();
  return useQuery<StaffPay[], ApiError>({
    queryKey: ['staff-pay', slug, staffId],
    enabled: !!slug && !!staffId,
    queryFn: () =>
      request<{ pay: StaffPay[] }>('GET', `/v1/staff/${staffId}/pay`, { tenantSlug: slug! }).then(
        (r) => r.pay,
      ),
  });
}

export function useCreateStaffPay(staffId: string) {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<StaffPay, ApiError, StaffPayInput>({
    mutationFn: (body) =>
      request<StaffPay>('POST', `/v1/staff/${staffId}/pay`, { tenantSlug: slug!, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff-pay', slug, staffId] }),
  });
}

export function useDeleteStaffPay(staffId: string) {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (payId) =>
      request('DELETE', `/v1/staff/${staffId}/pay/${payId}`, { tenantSlug: slug! }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['staff-pay', slug, staffId] }),
  });
}

/**
 * Fetch a private staff document and return an object URL for it. The bytes
 * are gated server-side by `staff:read`; we send the bearer token (an `<img>`
 * src can't), transparently refresh once on 401, and hand back a blob URL the
 * caller must `URL.revokeObjectURL` when done. Works for both images and PDFs.
 */
export async function fetchStaffDocBlob(
  slug: string,
  staffId: string,
  docId: string,
  retried = false,
): Promise<string> {
  const at = getAccessToken();
  const res = await fetch(url(`/v1/staff/${staffId}/documents/${docId}/file`), {
    headers: { 'X-Tenant-ID': slug, ...(at ? { Authorization: `Bearer ${at}` } : {}) },
  });
  if (res.status === 401 && !retried && getRefreshToken()) {
    const result = await refreshTokens();
    if (result === 'ok') return fetchStaffDocBlob(slug, staffId, docId, true);
    if (result === 'invalid') handleUnauthenticated();
  }
  if (!res.ok) throw { status: res.status, message: res.statusText } as ApiError;
  return URL.createObjectURL(await res.blob());
}


export function usePopularMenuItems(limit = 8) {
  const { slug } = useTenant();
  return useQuery<PopularMenuItem[], ApiError>({
    queryKey: ['menu-popular', slug, limit],
    enabled: !!slug,
    staleTime: 60_000,
    queryFn: () =>
      request<ListResp<'items', PopularMenuItem>>('GET', `/v1/menu/popular?limit=${limit}`, {
        tenantSlug: slug!,
      }).then((r) => r.items),
  });
}

// =========================================================================
// Service tables
// =========================================================================


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







export function useOrders(status?: OrderStatus) {
  const { slug } = useTenant();
  return useQuery<Order[], ApiError>({
    queryKey: ['orders', slug, status ?? 'all'],
    enabled: !!slug,
    // The floor/move views read each tab's live totals from this list. An
    // item added/edited on the tab patches only the per-order detail cache,
    // so this list goes stale the moment you leave the floor. staleTime: 0
    // forces a revalidate every time the floor remounts, so navigating back
    // always shows fresh totals — no full page reload needed.
    staleTime: 0,
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
  return useMutation<Order, ApiError, { service_table_id?: string; table_label?: string; notes?: string }>({
    mutationFn: (body) => request('POST', '/v1/orders', { tenantSlug: slug!, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['tables'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Optimistic cache helpers — recompute a tab's derived totals/counts from its
// line items so an optimistic write matches the shape the server would return
// (the floor/tab UIs read these without a refetch).
// ---------------------------------------------------------------------------

function recomputeOrderDerived(o: Order): Order {
  const items = o.items ?? [];
  let live = 0;
  let pending = 0;
  let inProgress = 0;
  let ready = 0;
  let served = 0;
  let total = 0;
  for (const i of items) {
    if (i.voided_at) continue;
    total += 1;
    live += i.line_cents ?? 0;
    if (i.kitchen_status === 'pending') pending += 1;
    else if (i.kitchen_status === 'in_progress') inProgress += 1;
    else if (i.kitchen_status === 'ready') ready += 1;
    else if (i.kitchen_status === 'served') served += 1;
  }
  return {
    ...o,
    live_subtotal_cents: live,
    items_total: total,
    items_pending: pending,
    items_in_progress: inProgress,
    items_ready: ready,
    items_served: served,
  };
}

/** Apply `fn` to a cached Order (if present) and rewrite its derived totals.
 *  Returns the previous value so the caller can roll back on error. */
function patchOrderCache(
  qc: QueryClient,
  key: unknown[],
  fn: (o: Order) => Order,
): Order | undefined {
  const prev = qc.getQueryData<Order>(key);
  if (prev) qc.setQueryData<Order>(key, recomputeOrderDerived(fn(prev)));
  return prev;
}

// Line ids whose add request is in flight RIGHT NOW (online path). Edits on
// them are skipped until the insert lands — a follow-up tap stacks instead.
// (Offline-queued lines are NOT in this set: edits on them queue behind the
// add, which is safe because replay is FIFO per order.)
const inFlightAddIds = new Set<string>();

/** True while a line's insert hasn't been confirmed by the server AND we're
 *  online (so a PATCH against it would 404). Replaces the old `temp:` id
 *  scheme — lines now carry their final client-generated UUID from birth. */
export function isUnconfirmedItemId(id: string): boolean {
  return inFlightAddIds.has(id) && !isOffline();
}


export function useAddOrderItems() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<{ items: OrderItemRow[] }, ApiError, AddOrderItemsVars, { prev?: Order }>({
    mutationFn: ({ orderId, items, optimistic }) => {
      if (isOffline()) {
        // Capture for replay-on-reconnect; the optimistic cache row (below)
        // is the user-visible result for now.
        const label = optimistic
          ? `${items[0]?.qty ?? 1}× ${optimistic.menu_item_name}`
          : `Add ${items.length} item(s)`;
        enqueueOp({
          tenantSlug: slug!,
          orderId,
          kind: 'add_items',
          payload: { items } satisfies QueuedAddPayload,
          label,
        });
        return Promise.resolve({ items: [] });
      }
      return request('POST', `/v1/orders/${orderId}/items`, { tenantSlug: slug!, body: { items } });
    },
    onMutate: async (vars) => {
      const it0 = vars.items[0];
      for (const it of vars.items) inFlightAddIds.add(it.id);
      if (!vars.optimistic || !it0) return {};
      const key = ['order', slug, vars.orderId];
      await qc.cancelQueries({ queryKey: key });
      const { menu_item_name, unit_price_cents } = vars.optimistic;
      const prev = patchOrderCache(qc, key, (o) => ({
        ...o,
        items: [
          ...(o.items ?? []),
          {
            id: it0.id,
            order_id: vars.orderId,
            menu_item_id: it0.menu_item_id,
            menu_item_name,
            qty: it0.qty,
            unit_price_cents,
            line_cents: it0.qty * unit_price_cents,
            modifiers: it0.modifiers ?? {},
            notes: it0.notes ?? '',
            kitchen_status: 'pending',
            created_at: new Date().toISOString(),
          } as OrderItemRow,
        ],
      }));
      return { prev };
    },
    onSuccess: (data, vars) => {
      // Reconcile the optimistic row with the server's canonical row (same
      // id — the client generated it) so derived fields match the server.
      if (vars.optimistic && data.items?.[0]) {
        const real = data.items[0];
        patchOrderCache(qc, ['order', slug, vars.orderId], (o) => ({
          ...o,
          items: (o.items ?? []).map((i) => (i.id === real.id ? { ...real } : i)),
        }));
      }
    },
    onError: (_e, vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['order', slug, vars.orderId], ctx.prev);
    },
    onSettled: (_d, _e, vars) => {
      for (const it of vars.items) inFlightAddIds.delete(it.id);
      // Offline: a refetch would just error and there's nothing fresher to
      // pull — the optimistic cache IS the state until replay.
      if (isOffline()) return;
      qc.invalidateQueries({ queryKey: ['order', slug, vars.orderId] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      // The settle quote is a separate query (TabPage + SettleModal read it);
      // without this the settle view shows a stale/empty total until refresh.
      qc.invalidateQueries({ queryKey: ['order-quote', slug, vars.orderId] });
    },
  });
}

export function useUpdateOrderItem() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    void,
    ApiError,
    {
      orderId: string;
      itemId: string;
      patch: { qty?: number; notes?: string; modifiers?: unknown };
      /** Human label for the offline review tray, e.g. "Cappuccino ×3". */
      offlineLabel?: string;
    },
    { prev?: Order }
  >({
    mutationFn: ({ orderId, itemId, patch, offlineLabel }) => {
      if (isOffline()) {
        enqueueOp({
          tenantSlug: slug!,
          orderId,
          kind: 'update_item',
          payload: { itemId, patch } satisfies QueuedUpdatePayload,
          label: offlineLabel ?? 'Edit line',
        });
        return Promise.resolve();
      }
      return request('PATCH', `/v1/orders/${orderId}/items/${itemId}`, { tenantSlug: slug!, body: patch });
    },
    onMutate: async ({ orderId, itemId, patch }) => {
      const key = ['order', slug, orderId];
      await qc.cancelQueries({ queryKey: key });
      const prev = patchOrderCache(qc, key, (o) => ({
        ...o,
        items: (o.items ?? []).map((i) =>
          i.id === itemId
            ? {
                ...i,
                qty: patch.qty ?? i.qty,
                notes: patch.notes ?? i.notes,
                line_cents: (patch.qty ?? i.qty) * i.unit_price_cents,
              }
            : i,
        ),
      }));
      return { prev };
    },
    onError: (_e, vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['order', slug, vars.orderId], ctx.prev);
    },
    onSettled: (_d, _e, vars) => {
      if (isOffline()) return; // optimistic cache is the state until replay
      qc.invalidateQueries({ queryKey: ['order', slug, vars.orderId] });
      // A qty/notes edit changes the tab's live subtotal, so the floor's
      // open-orders list must refresh too (matches add/void). The quick-add
      // "stack onto existing line" path routes through here.
      qc.invalidateQueries({ queryKey: ['orders'] });
      // Keep the settle quote in sync — see useAddOrderItems.
      qc.invalidateQueries({ queryKey: ['order-quote', slug, vars.orderId] });
    },
  });
}

export function useVoidOrderItem() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    void,
    ApiError,
    { orderId: string; itemId: string; reason: string; offlineLabel?: string },
    { prevOrder?: Order; prevKitchen?: KitchenTicket[] }
  >({
    mutationFn: ({ orderId, itemId, offlineLabel, ...body }) => {
      if (isOffline()) {
        enqueueOp({
          tenantSlug: slug!,
          orderId,
          kind: 'void_item',
          payload: { itemId, reason: body.reason } satisfies QueuedVoidPayload,
          label: offlineLabel ?? 'Remove line',
        });
        return Promise.resolve();
      }
      return request('POST', `/v1/orders/${orderId}/items/${itemId}/void`, { tenantSlug: slug!, body });
    },
    onMutate: async ({ orderId, itemId }) => {
      const okey = ['order', slug, orderId];
      const kkey = ['kitchen-tickets', slug];
      await Promise.all([qc.cancelQueries({ queryKey: okey }), qc.cancelQueries({ queryKey: kkey })]);
      const prevOrder = patchOrderCache(qc, okey, (o) => ({
        ...o,
        items: (o.items ?? []).map((i) =>
          i.id === itemId ? { ...i, voided_at: new Date().toISOString() } : i,
        ),
      }));
      const prevKitchen = qc.getQueryData<KitchenTicket[]>(kkey);
      if (prevKitchen) {
        qc.setQueryData<KitchenTicket[]>(
          kkey,
          prevKitchen.filter((t) => t.item_id !== itemId),
        );
      }
      return { prevOrder, prevKitchen };
    },
    onError: (_e, vars, ctx) => {
      if (ctx?.prevOrder) qc.setQueryData(['order', slug, vars.orderId], ctx.prevOrder);
      if (ctx?.prevKitchen) qc.setQueryData(['kitchen-tickets', slug], ctx.prevKitchen);
    },
    onSettled: (_d, _e, vars) => {
      if (isOffline()) return; // optimistic cache is the state until replay
      qc.invalidateQueries({ queryKey: ['order', slug, vars.orderId] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['kitchen-tickets', slug] });
      // Keep the settle quote in sync — see useAddOrderItems.
      qc.invalidateQueries({ queryKey: ['order-quote', slug, vars.orderId] });
    },
  });
}

export function useMoveOrder() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    { order_id: string; merged: boolean },
    ApiError,
    { orderId: string; service_table_id: string | null }
  >({
    mutationFn: ({ orderId, service_table_id }) =>
      request('POST', `/v1/orders/${orderId}/move`, {
        tenantSlug: slug!,
        body: { service_table_id },
      }),
    onSuccess: (data, vars) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['tables'] });
      qc.invalidateQueries({ queryKey: ['order', slug, vars.orderId] });
      if (data.order_id !== vars.orderId) {
        qc.invalidateQueries({ queryKey: ['order', slug, data.order_id] });
      }
    },
  });
}

// Name a walk-in / "Unknown +" tab (free-text label). Blank clears it back to
// the "Walk-in" / "Take-away" fallback.
export function useRenameOrder() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, { orderId: string; table_label: string }>({
    mutationFn: ({ orderId, table_label }) =>
      request('POST', `/v1/orders/${orderId}/rename`, {
        tenantSlug: slug!,
        body: { table_label },
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['order', slug, vars.orderId] });
    },
  });
}

// =========================================================================
// Order history (day-wise closed serves, optionally by table)
// =========================================================================




export function useOrderHistory(date: string | undefined, tableId?: string) {
  const { slug } = useTenant();
  return useQuery<OrderHistoryResp, ApiError>({
    queryKey: ['order-history', slug, date ?? 'today', tableId ?? 'all'],
    enabled: !!slug,
    queryFn: () => {
      const qs = new URLSearchParams();
      if (date) qs.set('date', date);
      if (tableId) qs.set('table_id', tableId);
      const s = qs.toString();
      return request<OrderHistoryResp>('GET', `/v1/orders/history${s ? `?${s}` : ''}`, {
        tenantSlug: slug!,
      });
    },
  });
}

// =========================================================================
// Discounts / order adjustments (M11)
// =========================================================================



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
    { orderId: string; type: AdjustmentType; amount_cents: number; reason: string }
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
  return useMutation<void, ApiError, { orderId: string; adjId: string }>({
    mutationFn: ({ orderId, adjId }) =>
      request('DELETE', `/v1/orders/${orderId}/adjustments/${adjId}`, {
        tenantSlug: slug!,
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['order-adjustments', slug, vars.orderId] });
      qc.invalidateQueries({ queryKey: ['order-quote', slug, vars.orderId] });
    },
  });
}


// =========================================================================
// Tenant settings + branding (M12)
// =========================================================================







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
      vat_mode?: VatMode;
      service_charge_pct?: string;
      branding?: Partial<TenantBranding>;
      preferences?: Partial<TenantPreferences>;
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
      const at = getAccessToken();
      const res = await fetch(url('/v1/tenant/logo'), {
        method: 'POST',
        headers: {
          'X-Tenant-ID': slug!,
          ...(at ? { Authorization: `Bearer ${at}` } : {}),
        },
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
    mutationFn: (orderId) => {
      if (isOffline()) {
        // Queue the send and flip pending lines locally; the kitchen only
        // actually receives the ticket when the queue replays. The per-line
        // cloud-off glyph + "waiting to sync" header make that visible.
        enqueueOp({
          tenantSlug: slug!,
          orderId,
          kind: 'send_kitchen',
          payload: {},
          label: 'Send to kitchen',
        });
        let sent = 0;
        patchOrderCache(qc, ['order', slug, orderId], (o) => ({
          ...o,
          items: (o.items ?? []).map((i) => {
            if (i.kitchen_status !== 'pending' || i.voided_at) return i;
            sent += 1;
            return { ...i, kitchen_status: 'in_progress', sent_to_kitchen_at: new Date().toISOString() };
          }),
        }));
        return Promise.resolve({ sent });
      }
      return request('POST', `/v1/orders/${orderId}/send-to-kitchen`, { tenantSlug: slug! });
    },
    onSuccess: (_d, orderId) => {
      if (isOffline()) return;
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



export function useShiftPayments(shiftId: string | null | undefined, enabled = true) {
  const { slug } = useTenant();
  return useQuery<ShiftPayment[], ApiError>({
    queryKey: ['shift-payments', slug, shiftId],
    enabled: !!slug && !!shiftId && enabled,
    queryFn: () =>
      request<ListResp<'payments', ShiftPayment>>('GET', `/v1/shifts/${shiftId}/payments`, {
        tenantSlug: slug!,
      }).then((r) => r.payments),
  });
}




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

export function useCurrentShift(opts?: { enabled?: boolean }) {
  const { slug } = useTenant();
  return useQuery<Shift | null, ApiError>({
    queryKey: ['current-shift', slug],
    // Caller can gate on `shift:read` so members without it don't poll a 403.
    enabled: !!slug && (opts?.enabled ?? true),
    queryFn: () => request<Shift | null>('GET', '/v1/shifts/current', { tenantSlug: slug! }),
    // Polled app-wide (the shift pill is in AdminShell). Shift open/close is
    // infrequent and the realtime WS already invalidates this, so a 60s
    // fallback poll is plenty — halves the background request rate per client.
    refetchInterval: 60_000,
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


// Build the query string for a dashboard/analytics report request. from/to are
// only appended for a 'custom' range; presets resolve server-side.
function dashRangeQS(range: DashboardRange, custom?: DashboardCustom): string {
  const qs = new URLSearchParams({ range });
  if (range === 'custom') {
    if (custom?.from) qs.set('from', custom.from);
    if (custom?.to) qs.set('to', custom.to);
  }
  return qs.toString();
}

// A custom range is only fetchable once both endpoints are picked.
function dashRangeReady(range: DashboardRange, custom?: DashboardCustom): boolean {
  return range !== 'custom' || (!!custom?.from && !!custom?.to);
}







export function useReportsDashboard(range: DashboardRange = 'today', custom?: DashboardCustom) {
  const { slug } = useTenant();
  const qs = dashRangeQS(range, custom);
  return useQuery<ReportsDashboard, ApiError>({
    queryKey: ['reports-dashboard', slug, qs],
    enabled: !!slug && dashRangeReady(range, custom),
    queryFn: () =>
      request<ReportsDashboard>('GET', `/v1/reports/dashboard?${qs}`, { tenantSlug: slug! }),
    refetchInterval: 60_000, // pull a fresh snapshot every minute
  });
}

// -----------------------------------------------------------------------------
// Hourly breakdown — orders + revenue bucketed by hour-of-day for a single
// tenant-local day. Powers the dashboard "Hourly" tab.
// -----------------------------------------------------------------------------



/** Pass a YYYY-MM-DD date; omit/empty for today. */
export function useHourly(date?: string) {
  const { slug } = useTenant();
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  return useQuery<HourlyResp, ApiError>({
    queryKey: ['reports-hourly', slug, date ?? 'today'],
    enabled: !!slug,
    queryFn: () => request<HourlyResp>('GET', `/v1/reports/hourly${qs}`, { tenantSlug: slug! }),
    refetchInterval: 60_000,
  });
}

// -----------------------------------------------------------------------------
// Analytics expansion — top sellers w/ delta, peak-hours heatmap, category +
// table mix donuts, throughput velocity. Each endpoint shares the dashboard
// range vocabulary so the chip-row selector drives all of them at once.
// -----------------------------------------------------------------------------



export function useTopSellers(range: DashboardRange = 'today', custom?: DashboardCustom) {
  const { slug } = useTenant();
  const qs = dashRangeQS(range, custom);
  return useQuery<TopSellersResp, ApiError>({
    queryKey: ['reports-top-sellers', slug, qs],
    enabled: !!slug && dashRangeReady(range, custom),
    queryFn: () =>
      request<TopSellersResp>('GET', `/v1/reports/top-sellers?${qs}`, { tenantSlug: slug! }),
    refetchInterval: 60_000,
  });
}



export function useHeatmap(range: DashboardRange = '30d', custom?: DashboardCustom) {
  const { slug } = useTenant();
  const qs = dashRangeQS(range, custom);
  return useQuery<HeatmapResp, ApiError>({
    queryKey: ['reports-heatmap', slug, qs],
    enabled: !!slug && dashRangeReady(range, custom),
    queryFn: () =>
      request<HeatmapResp>('GET', `/v1/reports/heatmap?${qs}`, { tenantSlug: slug! }),
    refetchInterval: 60_000,
  });
}


export function useCategoryMix(range: DashboardRange = 'today', custom?: DashboardCustom) {
  const { slug } = useTenant();
  const qs = dashRangeQS(range, custom);
  return useQuery<{ range: string; from: string; to: string; rows: CategoryMixRow[] }, ApiError>({
    queryKey: ['reports-category-mix', slug, qs],
    enabled: !!slug && dashRangeReady(range, custom),
    queryFn: () =>
      request('GET', `/v1/reports/category-mix?${qs}`, { tenantSlug: slug! }),
    refetchInterval: 60_000,
  });
}


export function useTableMix(range: DashboardRange = 'today', custom?: DashboardCustom) {
  const { slug } = useTenant();
  const qs = dashRangeQS(range, custom);
  return useQuery<{ range: string; from: string; to: string; rows: TableMixRow[] }, ApiError>({
    queryKey: ['reports-table-mix', slug, qs],
    enabled: !!slug && dashRangeReady(range, custom),
    queryFn: () =>
      request('GET', `/v1/reports/table-mix?${qs}`, { tenantSlug: slug! }),
    refetchInterval: 60_000,
  });
}



export function useVelocity(range: DashboardRange = '30d', custom?: DashboardCustom) {
  const { slug } = useTenant();
  const qs = dashRangeQS(range, custom);
  return useQuery<VelocityResp, ApiError>({
    queryKey: ['reports-velocity', slug, qs],
    enabled: !!slug && dashRangeReady(range, custom),
    queryFn: () =>
      request<VelocityResp>('GET', `/v1/reports/velocity?${qs}`, { tenantSlug: slug! }),
    refetchInterval: 60_000,
  });
}

// =========================================================================
// Profitability (M9)
// =========================================================================



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

export function useExpenses(params?: {
  from?: string;
  to?: string;
  expense_category_id?: string;
  q?: string;
  paid_from?: ExpensePaidFrom;
}) {
  const { slug } = useTenant();
  const qs = new URLSearchParams();
  if (params?.from) qs.set('from', params.from);
  if (params?.to) qs.set('to', params.to);
  if (params?.expense_category_id) qs.set('expense_category_id', params.expense_category_id);
  if (params?.q) qs.set('q', params.q);
  if (params?.paid_from) qs.set('paid_from', params.paid_from);
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

/** Single expense with its allocations — the list rows don't carry them. */
export function useExpense(id?: string | null) {
  const { slug } = useTenant();
  return useQuery<Expense, ApiError>({
    queryKey: ['expense', slug, id],
    enabled: !!slug && !!id,
    queryFn: () => request<Expense>('GET', `/v1/expenses/${id}`, { tenantSlug: slug! }),
  });
}

/** Recently-used vendor names, newest first — feeds the form's datalist. */
export function useExpenseVendors() {
  const { slug } = useTenant();
  return useQuery<string[], ApiError>({
    queryKey: ['expense-vendors', slug],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'vendors', string>>('GET', '/v1/expenses/vendors', {
        tenantSlug: slug!,
      }).then((r) => r.vendors),
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
      qc.invalidateQueries({ queryKey: ['inventory-movements-paged'] });
      qc.invalidateQueries({ queryKey: ['current-shift', slug] });
      qc.invalidateQueries({ queryKey: ['cash-drops'] });
      qc.invalidateQueries({ queryKey: ['accounts-balances'] });
      // Expenses move the cafe balance (drawer/bank/owner-cash) and the owner
      // ledgers — refresh the finance views too.
      qc.invalidateQueries({ queryKey: ['cafe-balance'] });
      qc.invalidateQueries({ queryKey: ['cafe-summary'] });
      qc.invalidateQueries({ queryKey: ['owner-cash'] });
      qc.invalidateQueries({ queryKey: ['owner-ledger'] });
    },
  });
}


export function useUpdateExpense() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<Expense, ApiError, { id: string; patch: UpdateExpenseInput }>({
    mutationFn: ({ id, patch }) =>
      request('PATCH', `/v1/expenses/${id}`, { tenantSlug: slug!, body: patch }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['expense', slug, vars.id] });
      qc.invalidateQueries({ queryKey: ['expense-vendors', slug] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['inventory-movements'] });
      qc.invalidateQueries({ queryKey: ['inventory-movements-paged'] });
      qc.invalidateQueries({ queryKey: ['current-shift', slug] });
      qc.invalidateQueries({ queryKey: ['cash-drops'] });
      qc.invalidateQueries({ queryKey: ['accounts-balances'] });
      // An edit can change amount/source, which moves the cafe balance and the
      // owner-cash custody draw-down — refresh the finance views too.
      qc.invalidateQueries({ queryKey: ['cafe-balance'] });
      qc.invalidateQueries({ queryKey: ['cafe-summary'] });
      qc.invalidateQueries({ queryKey: ['owner-cash'] });
      qc.invalidateQueries({ queryKey: ['owner-ledger'] });
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
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['inventory-movements'] });
      qc.invalidateQueries({ queryKey: ['inventory-movements-paged'] });
      qc.invalidateQueries({ queryKey: ['current-shift', slug] });
      qc.invalidateQueries({ queryKey: ['cash-drops'] });
      qc.invalidateQueries({ queryKey: ['accounts-balances'] });
      // Deleting an expense undoes its drawer/owner-cash movements server-side
      // (cascade in DeleteExpense). Mirror useCreateExpense so the finance views —
      // including the owner "Cash with owners → Recent movements" list — refresh
      // instead of showing the now-removed entry from stale cache.
      qc.invalidateQueries({ queryKey: ['cafe-balance'] });
      qc.invalidateQueries({ queryKey: ['cafe-summary'] });
      qc.invalidateQueries({ queryKey: ['owner-cash'] });
      qc.invalidateQueries({ queryKey: ['owner-ledger'] });
    },
  });
}

// =========================================================================
// Inventory (M6)
// =========================================================================






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

const MOVEMENTS_PAGE_SIZE = 50;

type MovementsPage = { movements: StockMovement[]; total: number };

/** Full movement history for one item, 50 rows at a time (newest first). */
export function useInventoryMovementsPaged(itemId?: string) {
  const { slug } = useTenant();
  return useInfiniteQuery<MovementsPage, ApiError>({
    queryKey: ['inventory-movements-paged', slug, itemId],
    enabled: !!slug && !!itemId,
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      request<MovementsPage>(
        'GET',
        `/v1/inventory/${itemId}/movements?limit=${MOVEMENTS_PAGE_SIZE}&offset=${pageParam as number}`,
        { tenantSlug: slug! },
      ),
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((n, p) => n + p.movements.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
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
      qc.invalidateQueries({ queryKey: ['inventory-movements-paged', slug, vars.id] });
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

export function useMenuItemLinks(menuItemId?: string) {
  const { slug } = useTenant();
  return useQuery<MenuItemInventoryLink[], ApiError>({
    queryKey: ['menu-item-links', slug, menuItemId],
    enabled: !!slug && !!menuItemId,
    queryFn: async () => {
      const r = await request<{ links: MenuItemInventoryLink[] }>(
        'GET',
        `/v1/menu/items/${menuItemId}/inventory-link`,
        { tenantSlug: slug! },
      );
      return r.links ?? [];
    },
  });
}

export function usePutMenuItemLinks() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    { links: MenuItemInventoryLink[] },
    ApiError,
    { menuItemId: string; links: { inventory_item_id: string; qty_consumed_per_sale: string }[] }
  >({
    mutationFn: ({ menuItemId, links }) =>
      request('PUT', `/v1/menu/items/${menuItemId}/inventory-link`, {
        tenantSlug: slug!,
        body: { links },
      }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ['menu-item-links', slug, vars.menuItemId] }),
  });
}

// =========================================================================
// Payments + close
// =========================================================================




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

/** Flip a payment cash↔online to fix a wrong-method entry. Works on closed
 *  orders too, but only while the payment's shift is still open — the
 *  server rejects it once the drawer variance is stamped. */
export function useReclassifyPayment() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    Payment,
    ApiError,
    { orderId: string; paymentId: string; method: 'cash' | 'online' }
  >({
    mutationFn: ({ orderId, paymentId, method }) =>
      request('POST', `/v1/orders/${orderId}/payments/${paymentId}/reclassify`, {
        tenantSlug: slug!,
        body: { method },
      }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['order-payments', slug, vars.orderId] });
      qc.invalidateQueries({ queryKey: ['order-quote', slug, vars.orderId] });
      qc.invalidateQueries({ queryKey: ['current-shift', slug] });
      qc.invalidateQueries({ queryKey: ['shift-payments', slug] });
      qc.invalidateQueries({ queryKey: ['accounts-balances'] });
      // History page reflects the live method, so refresh it after a flip.
      qc.invalidateQueries({ queryKey: ['order-history', slug] });
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
  return useMutation<
    void,
    ApiError,
    { itemId: string; kitchen_status: 'ready' | 'served' },
    { prev?: KitchenTicket[] }
  >({
    mutationFn: ({ itemId, kitchen_status }) =>
      request('PATCH', `/v1/kitchen/tickets/${itemId}`, {
        tenantSlug: slug!,
        body: { kitchen_status },
      }),
    // Optimistic: the card moves/clears the instant it's tapped; the server
    // confirmation (and WS event) reconcile on settle. Rolls back on error.
    onMutate: async ({ itemId, kitchen_status }) => {
      const kkey = ['kitchen-tickets', slug];
      await qc.cancelQueries({ queryKey: kkey });
      const prev = qc.getQueryData<KitchenTicket[]>(kkey);
      if (prev) {
        const ticket = prev.find((t) => t.item_id === itemId);
        const next =
          kitchen_status === 'served'
            ? prev.filter((t) => t.item_id !== itemId)
            : prev.map((t) =>
                t.item_id === itemId
                  ? { ...t, kitchen_status: 'ready' as const, ready_at: new Date().toISOString() }
                  : t,
              );
        qc.setQueryData<KitchenTicket[]>(kkey, next);
        // Keep an open tab detail view in sync too (status flows through to
        // the line's kitchen_status / served_at).
        if (ticket) {
          patchOrderCache(qc, ['order', slug, ticket.order_id], (o) => ({
            ...o,
            items: (o.items ?? []).map((i) =>
              i.id === itemId
                ? {
                    ...i,
                    kitchen_status,
                    ready_at: kitchen_status === 'ready' ? new Date().toISOString() : i.ready_at,
                    served_at: kitchen_status === 'served' ? new Date().toISOString() : i.served_at,
                  }
                : i,
            ),
          }));
        }
      }
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['kitchen-tickets', slug], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['kitchen-tickets', slug] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    },
  });
}

// =========================================================================
// Members (multi-role)
// =========================================================================


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

/** Soft-removes a member from the current workspace: drops all role rows for
 *  this (tenant, user) and revokes their active sessions scoped to it. The
 *  underlying user account is left untouched — historical records that
 *  reference user_id stay valid for audit. */
export function useRemoveMember() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, { userId: string }>({
    mutationFn: ({ userId }) =>
      request('DELETE', `/v1/members/${userId}`, { tenantSlug: slug! }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['members', slug] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

// =========================================================================
// House tabs (stakeholder running ledgers)
// =========================================================================





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
    { id: string; amount_cents: number; payment_method: PaymentMethod; reference_no?: string; notes?: string }
  >({
    mutationFn: ({ id, ...body }) =>
      request('POST', `/v1/house-tabs/${id}/settlements`, { tenantSlug: slug!, body }),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['house-tabs', slug] });
      qc.invalidateQueries({ queryKey: ['house-tab', slug, vars.id] });
    },
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

// =========================================================================
// Audit log (Activity page) — owner/manager only
// =========================================================================




type AuditPage = { items: AuditEvent[]; next_cursor: string | null };

function buildAuditQuery(filters: AuditFilters, cursor?: string): string {
  const p = new URLSearchParams();
  for (const v of filters.actor ?? []) p.append('actor', v);
  for (const v of filters.entity ?? []) p.append('entity', v);
  for (const v of filters.action ?? []) p.append('action', v);
  if (filters.from) p.set('from', filters.from);
  if (filters.to) p.set('to', filters.to);
  if (filters.q) p.set('q', filters.q);
  if (cursor) p.set('cursor', cursor);
  p.set('limit', '50');
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function useAuditEvents(filters: AuditFilters) {
  const { slug } = useTenant();
  return useInfiniteQuery<AuditPage, ApiError>({
    queryKey: ['audit', slug, filters],
    enabled: !!slug,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      request<AuditPage>('GET', `/v1/audit${buildAuditQuery(filters, pageParam as string | undefined)}`, {
        tenantSlug: slug!,
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
}

export function useAuditActors() {
  const { slug } = useTenant();
  return useQuery<AuditActor[], ApiError>({
    queryKey: ['audit-actors', slug],
    enabled: !!slug,
    queryFn: () =>
      request<{ actors: AuditActor[] }>('GET', '/v1/audit/actors', { tenantSlug: slug! }).then(
        (r) => r.actors,
      ),
  });
}

// =========================================================================
// Cafe finance (0014) — owners, owner ledger, aggregate balance.
// =========================================================================





export function useCafeBalance() {
  const { slug } = useTenant();
  return useQuery<CafeBalance, ApiError>({
    queryKey: ['cafe-balance', slug],
    enabled: !!slug,
    queryFn: () => request<CafeBalance>('GET', '/v1/finance/cafe-balance', { tenantSlug: slug! }),
    refetchInterval: 30_000,
  });
}


export function useCafeSummary() {
  const { slug } = useTenant();
  return useQuery<CafeSummary, ApiError>({
    queryKey: ['cafe-summary', slug],
    enabled: !!slug,
    queryFn: () => request<CafeSummary>('GET', '/v1/finance/cafe-summary', { tenantSlug: slug! }),
    refetchInterval: 60_000,
  });
}

export function useCafeOwners(opts: { activeOnly?: boolean } = {}) {
  const { slug } = useTenant();
  const qs = opts.activeOnly ? '?active=true' : '';
  return useQuery<CafeOwner[], ApiError>({
    queryKey: ['cafe-owners', slug, opts.activeOnly ?? false],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'owners', CafeOwner>>('GET', `/v1/finance/owners${qs}`, {
        tenantSlug: slug!,
      }).then((r) => r.owners),
  });
}

const FINANCE_KEYS = [
  ['cafe-balance'],
  ['cafe-summary'],
  ['cafe-owners'],
  ['owner-ledger'],
  ['owner-cash'],
  ['accounts-balances'],
] as const;

function invalidateFinance(qc: ReturnType<typeof useQueryClient>) {
  for (const k of FINANCE_KEYS) {
    qc.invalidateQueries({ queryKey: k as readonly unknown[] });
  }
}

export function useCreateCafeOwner() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    CafeOwner,
    ApiError,
    { user_id?: string | null; display_name: string; share_units: number; notes?: string }
  >({
    mutationFn: (body) => request('POST', '/v1/finance/owners', { tenantSlug: slug!, body }),
    onSuccess: () => invalidateFinance(qc),
  });
}

export function useUpdateCafeOwner() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    CafeOwner,
    ApiError,
    { id: string; patch: { display_name?: string; share_units?: number; notes?: string } }
  >({
    mutationFn: ({ id, patch }) =>
      request('PATCH', `/v1/finance/owners/${id}`, { tenantSlug: slug!, body: patch }),
    onSuccess: () => invalidateFinance(qc),
  });
}

export function useDeactivateCafeOwner() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, { id: string; force?: boolean }>({
    mutationFn: ({ id, force }) =>
      request('POST', `/v1/finance/owners/${id}/deactivate`, {
        tenantSlug: slug!,
        body: { force: force ?? false },
      }),
    onSuccess: () => invalidateFinance(qc),
  });
}

export function useOwnerLedger(filters: { owner_id?: string; kind?: OwnerLedgerKind } = {}) {
  const { slug } = useTenant();
  const qs = new URLSearchParams();
  if (filters.owner_id) qs.set('owner_id', filters.owner_id);
  if (filters.kind) qs.set('kind', filters.kind);
  const qsStr = qs.toString();
  return useQuery<OwnerLedgerEntry[], ApiError>({
    queryKey: ['owner-ledger', slug, qsStr],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'entries', OwnerLedgerEntry>>(
        'GET',
        `/v1/finance/owner-ledger${qsStr ? '?' + qsStr : ''}`,
        { tenantSlug: slug! },
      ).then((r) => r.entries),
  });
}

export function useRecordInvestment() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    { id: string },
    ApiError,
    { owner_id: string; amount_cents: number; notes?: string; occurred_at?: string }
  >({
    mutationFn: (body) => request('POST', '/v1/finance/investments', { tenantSlug: slug!, body }),
    onSuccess: () => invalidateFinance(qc),
  });
}

export function useRecordPayouts() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    { ids: string[]; total_cents: number },
    ApiError,
    { entries: PayoutEntryInput[]; notes?: string; occurred_at?: string }
  >({
    mutationFn: (body) => request('POST', '/v1/finance/payouts', { tenantSlug: slug!, body }),
    onSuccess: () => invalidateFinance(qc),
  });
}

export function useRepayLoan() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    { id: string },
    ApiError,
    { loan_id: string; amount_cents: number; notes?: string; occurred_at?: string }
  >({
    mutationFn: ({ loan_id, ...body }) =>
      request('POST', `/v1/finance/loans/${loan_id}/repay`, { tenantSlug: slug!, body }),
    onSuccess: () => invalidateFinance(qc),
  });
}

export function useCorrectLedgerEntry() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<{ id: string }, ApiError, { id: string; notes: string }>({
    mutationFn: ({ id, notes }) =>
      request('POST', `/v1/finance/owner-ledger/${id}/correct`, {
        tenantSlug: slug!,
        body: { notes },
      }),
    onSuccess: () => invalidateFinance(qc),
  });
}

// =========================================================================
// Owner cash custody (0034) — cafe cash an owner takes from the drawer and
// later reconciles (bank deposit / cafe expense / return to drawer).
// =========================================================================





export function useOwnerCash() {
  const { slug } = useTenant();
  return useQuery<OwnerCashResponse, ApiError>({
    queryKey: ['owner-cash', slug],
    enabled: !!slug,
    queryFn: () => request<OwnerCashResponse>('GET', '/v1/finance/owner-cash', { tenantSlug: slug! }),
    refetchInterval: 30_000,
  });
}

export function useOwnerCashWithdraw() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    { id: string; cash_drop_id: string },
    ApiError,
    { owner_id: string; amount_cents: number; notes?: string; occurred_at?: string }
  >({
    mutationFn: (body) =>
      request('POST', '/v1/finance/owner-cash/withdrawals', { tenantSlug: slug!, body }),
    onSuccess: () => invalidateFinance(qc),
  });
}

export function useOwnerCashReturn() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    { id: string; cash_drop_id: string },
    ApiError,
    { owner_id: string; amount_cents: number; notes?: string; occurred_at?: string }
  >({
    mutationFn: (body) =>
      request('POST', '/v1/finance/owner-cash/returns', { tenantSlug: slug!, body }),
    onSuccess: () => invalidateFinance(qc),
  });
}

export function useOwnerCashDeposit() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    { id: string },
    ApiError,
    { owner_id: string; amount_cents: number; reference_no?: string; notes?: string; occurred_at?: string }
  >({
    mutationFn: (body) =>
      request('POST', '/v1/finance/owner-cash/deposits', { tenantSlug: slug!, body }),
    onSuccess: () => invalidateFinance(qc),
  });
}

export function useDeleteOwnerCashEntry() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, { id: string }>({
    mutationFn: ({ id }) =>
      request('DELETE', `/v1/finance/owner-cash/${id}`, { tenantSlug: slug! }),
    onSuccess: () => invalidateFinance(qc),
  });
}

// =========================================================================
// RBAC: roles + permission manifest (0019)
// =========================================================================



export function usePermissionManifest() {
  const { slug } = useTenant();
  return useQuery<PermissionManifest, ApiError>({
    queryKey: ['permissions-manifest', slug],
    enabled: !!slug,
    staleTime: Infinity, // manifest only changes with deploys
    queryFn: () => request<PermissionManifest>('GET', '/v1/permissions', { tenantSlug: slug! }),
  });
}

export function useRoles() {
  const { slug } = useTenant();
  return useQuery<Role[], ApiError>({
    queryKey: ['roles', slug],
    enabled: !!slug,
    queryFn: () =>
      request<ListResp<'roles', Role>>('GET', '/v1/roles', { tenantSlug: slug! }).then(
        (r) => r.roles,
      ),
  });
}

export function useCreateRole() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    Role,
    ApiError,
    { key: string; name: string; description?: string; permissions: string[] }
  >({
    mutationFn: (body) => request('POST', '/v1/roles', { tenantSlug: slug!, body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles', slug] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

export function useUpdateRole() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<
    Role,
    ApiError,
    { id: string; name?: string; description?: string; permissions?: string[] }
  >({
    mutationFn: ({ id, ...patch }) =>
      request('PATCH', `/v1/roles/${id}`, { tenantSlug: slug!, body: patch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles', slug] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

export function useDeleteRole() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => request('DELETE', `/v1/roles/${id}`, { tenantSlug: slug! }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['roles', slug] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

// =========================================================================
// Plan / usage helpers (owner-facing). Read off the /me billing snapshot —
// no extra fetch. Safe before the BE billing fields land (all optional).
// =========================================================================


/** Whether the active tenant is read-only (trial expired past grace, or a
 *  manual super-admin lock). Reads the /me billing snapshot. */
export function useWriteLocked(): WriteLockState {
  const me = useMe();
  const b = me.data?.billing;
  return { locked: !!b?.write_locked, phase: b?.phase ?? 'active' };
}


/** Trial countdown derived from the /me billing snapshot. */
export function useTrialState(): TrialState {
  const me = useMe();
  const b = me.data?.billing;
  if (!b) return { phase: 'active' };
  let daysLeft: number | undefined;
  if (b.trial_ends_at) {
    const ms = new Date(b.trial_ends_at).getTime() - Date.now();
    daysLeft = Math.ceil(ms / 86_400_000);
  }
  return { phase: b.phase, endsAt: b.trial_ends_at, daysLeft };
}

// =========================================================================
// Super admin (/v1/super) — platform-wide, NOT tenant-scoped. These hooks
// deliberately omit tenantSlug and key their queries independently of the
// active tenant.
// =========================================================================



export function useAdminTenants() {
  return useQuery<AdminTenantsResponse, ApiError>({
    queryKey: ['super', 'tenants'],
    queryFn: () => request('GET', '/v1/super/tenants'),
  });
}


export function useAdminTenant(id: string | undefined) {
  return useQuery<AdminTenantDetail, ApiError>({
    queryKey: ['super', 'tenant', id],
    enabled: !!id,
    queryFn: () => request('GET', `/v1/super/tenants/${id}`),
  });
}

function useSuperMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, V>({
    mutationFn: fn as (v: V) => Promise<unknown>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['super', 'tenants'] });
      qc.invalidateQueries({ queryKey: ['super', 'tenant'] });
    },
  });
}

export function useAdminCreateTenant() {
  return useSuperMutation<{ name: string; slug?: string; timezone?: string; owner_email: string; plan_key?: string }>(
    (body) => request('POST', '/v1/super/tenants', { body }),
  );
}
export function useAdminChangePlan(id: string) {
  return useSuperMutation<{ plan_key: string }>((body) => request('PATCH', `/v1/super/tenants/${id}/plan`, { body }));
}
export function useAdminSetSeatOverride(id: string) {
  return useSuperMutation<{ member_limit: number | null }>((body) => request('PATCH', `/v1/super/tenants/${id}/member-limit`, { body }));
}
export function useAdminExtendTrial(id: string) {
  return useSuperMutation<{ days: number }>((body) => request('POST', `/v1/super/tenants/${id}/extend-trial`, { body }));
}


export function useAdminTenantPayments(id: string | undefined) {
  return useQuery<{ payments: AdminPayment[] }, ApiError>({
    queryKey: ['super', 'tenant-payments', id],
    enabled: !!id,
    queryFn: () => request('GET', `/v1/super/tenants/${id}/payments`),
  });
}


/** Record a manual payment — also advances the tenant's paid-through date. */
export function useAdminRecordPayment(id: string) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, RecordPaymentInput>({
    mutationFn: (body) => request('POST', `/v1/super/tenants/${id}/payments`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['super', 'tenants'] });
      qc.invalidateQueries({ queryKey: ['super', 'tenant'] });
      qc.invalidateQueries({ queryKey: ['super', 'tenant-payments', id] });
    },
  });
}

/** Set the paid-through date directly, or pass null to mark the tenant comped. */
export function useAdminSetSubscription(id: string) {
  return useSuperMutation<{ paid_through_at: string | null }>(
    (body) => request('PATCH', `/v1/super/tenants/${id}/subscription`, { body }),
  );
}
export function useAdminWriteLock(id: string) {
  return useSuperMutation<{ locked: boolean; note?: string }>((body) => request('POST', `/v1/super/tenants/${id}/write-lock`, { body }));
}
export function useAdminSuspend(id: string) {
  return useSuperMutation<void>(() => request('POST', `/v1/super/tenants/${id}/suspend`));
}
export function useAdminReactivate(id: string) {
  return useSuperMutation<void>(() => request('POST', `/v1/super/tenants/${id}/reactivate`));
}

export function useAdminTenantDataSummary(id: string | undefined) {
  return useQuery<TenantDataSummary, ApiError>({
    queryKey: ['super', 'tenant-data', id],
    enabled: !!id,
    queryFn: () => request('GET', `/v1/super/tenants/${id}/data-summary`),
  });
}

/** PERMANENT scoped purge. scopes=['everything'] removes the whole tenant;
 *  a partial set wipes just those categories (catalog scopes pull in
 *  'transactions' server-side). confirm_slug must equal the tenant slug. */
export function useAdminDeleteTenant(id: string) {
  const qc = useQueryClient();
  return useMutation<{ deleted: boolean; rows_purged: number }, ApiError, { confirm_slug: string; scopes: string[] }>({
    mutationFn: (body) => request('POST', `/v1/super/tenants/${id}/delete`, { body }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['super', 'tenants'] });
      qc.invalidateQueries({ queryKey: ['super', 'tenant'] });
      qc.invalidateQueries({ queryKey: ['super', 'tenant-data', id] });
      qc.invalidateQueries({ queryKey: ['me'] }); // memberships may have changed (self-delete)
    },
  });
}

// --- Plans CRUD ---


export function useAdminPlans() {
  return useQuery<{ plans: AdminPlan[] }, ApiError>({
    queryKey: ['super', 'plans'],
    queryFn: () => request('GET', '/v1/super/plans'),
  });
}
export function useAdminFeatures() {
  return useQuery<{ features: FeatureDef[] }, ApiError>({
    queryKey: ['super', 'features'],
    staleTime: Infinity,
    queryFn: () => request('GET', '/v1/super/features'),
  });
}
function usePlansMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, V>({
    mutationFn: fn as (v: V) => Promise<unknown>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['super', 'plans'] }),
  });
}
export function useAdminCreatePlan() {
  return usePlansMutation<PlanInput>((body) => request('POST', '/v1/super/plans', { body }));
}
export function useAdminUpdatePlan(id: string) {
  return usePlansMutation<PlanInput>((body) => request('PATCH', `/v1/super/plans/${id}`, { body }));
}
export function useAdminDeletePlan() {
  return usePlansMutation<string>((id) => request('DELETE', `/v1/super/plans/${id}`));
}

// --- Tenant requests queue ---


export function useAdminTenantRequests(state?: string) {
  return useQuery<{ requests: AdminTenantRequest[] }, ApiError>({
    queryKey: ['super', 'requests', state ?? 'all'],
    queryFn: () => request('GET', `/v1/super/requests${state ? `?state=${state}` : ''}`),
  });
}
function useRequestsMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, V>({
    mutationFn: fn as (v: V) => Promise<unknown>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['super', 'requests'] });
      qc.invalidateQueries({ queryKey: ['super', 'tenants'] });
    },
  });
}
export function useAdminApproveRequest() {
  return useRequestsMutation<{ id: string; slug?: string; timezone?: string; plan_key?: string }>(
    ({ id, ...body }) => request('POST', `/v1/super/requests/${id}/approve`, { body }),
  );
}
export function useAdminRejectRequest() {
  return useRequestsMutation<{ id: string; note?: string }>(
    ({ id, note }) => request('POST', `/v1/super/requests/${id}/reject`, { body: { note } }),
  );
}

// --- Platform admins ---


export function useAdminPlatformAdmins() {
  return useQuery<{ admins: PlatformAdminEntry[] }, ApiError>({
    queryKey: ['super', 'admins'],
    queryFn: () => request('GET', '/v1/super/admins'),
  });
}
function useAdminsMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, V>({
    mutationFn: fn as (v: V) => Promise<unknown>,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['super', 'admins'] }),
  });
}
export function useAdminAddPlatformAdmin() {
  return useAdminsMutation<{ email: string }>((body) => request('POST', '/v1/super/admins', { body }));
}
export function useAdminRemovePlatformAdmin() {
  return useAdminsMutation<string>((userId) => request('DELETE', `/v1/super/admins/${userId}`));
}


export function useAdminAudit() {
  return useQuery<{ events: PlatformAuditEvent[] }, ApiError>({
    queryKey: ['super', 'audit'],
    queryFn: () => request('GET', '/v1/super/audit'),
  });
}

// =========================================================================
// Offline replay engine
//
// Drains lib/offline-queue.ts when connectivity returns. Strictly FIFO per
// order (preserves add → edit → void → send causality within a tab) while
// independent tabs replay concurrently. Server-side idempotency (client line
// ids + ON CONFLICT, replay-safe void/send) makes a double replay harmless.
//
// Failure handling:
//   status 0  — still offline; the op stays 'queued' for the next attempt
//   4xx       — the server rejected it (tab settled elsewhere, item gone):
//               mark 'needs_review' and HALT that order's chain (later ops
//               likely depend on the failed one). Surfaced in the review
//               tray — never silently dropped.
//   5xx       — transient server trouble: keep queued, retry next transition
// =========================================================================

function execQueuedOp(op: QueuedOp): Promise<unknown> {
  switch (op.kind) {
    case 'add_items': {
      const p = op.payload as QueuedAddPayload;
      return request('POST', `/v1/orders/${op.orderId}/items`, {
        tenantSlug: op.tenantSlug,
        body: { items: p.items },
      });
    }
    case 'update_item': {
      const p = op.payload as QueuedUpdatePayload;
      return request('PATCH', `/v1/orders/${op.orderId}/items/${p.itemId}`, {
        tenantSlug: op.tenantSlug,
        body: p.patch,
      });
    }
    case 'void_item': {
      const p = op.payload as QueuedVoidPayload;
      return request('POST', `/v1/orders/${op.orderId}/items/${p.itemId}/void`, {
        tenantSlug: op.tenantSlug,
        body: { reason: p.reason },
      });
    }
    case 'send_kitchen':
      return request('POST', `/v1/orders/${op.orderId}/send-to-kitchen`, {
        tenantSlug: op.tenantSlug,
      });
  }
}

let replayInFlight = false;

export async function replayQueuedOps(qc: QueryClient): Promise<void> {
  if (replayInFlight) return;
  replayInFlight = true;
  try {
    const ops = getQueuedOps().filter((o) => o.status !== 'needs_review');
    if (ops.length === 0) return;

    // Group by order, preserving enqueue order within each group.
    const byOrder = new Map<string, QueuedOp[]>();
    for (const op of ops) {
      const chain = byOrder.get(op.orderId) ?? [];
      chain.push(op);
      byOrder.set(op.orderId, chain);
    }

    const touched = new Set<string>(); // orderIds that had at least one success

    await Promise.all(
      [...byOrder.values()].map(async (chain) => {
        for (const op of chain) {
          setOpStatus(op.id, 'replaying');
          try {
            await execQueuedOp(op);
            removeOp(op.id);
            touched.add(op.orderId);
          } catch (e) {
            const err = e as ApiError;
            if (err.status === 0 || err.status >= 500) {
              // Still offline / transient — back to queued, retry later.
              setOpStatus(op.id, 'queued');
            } else {
              setOpStatus(op.id, 'needs_review', {
                status: err.status,
                code: err.code,
                message: err.message,
              });
            }
            return; // halt this order's chain either way
          }
        }
      }),
    );

    // Restore server truth for everything the replay touched. ['order'] is a
    // prefix match, so every open order detail (any slug/orderId) refetches.
    if (touched.size > 0) {
      qc.invalidateQueries({ queryKey: ['order'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['tables'] });
      qc.invalidateQueries({ queryKey: ['kitchen-tickets'] });
    }
  } finally {
    replayInFlight = false;
  }
}

/** Mount once in AdminShell. Replays the queue when connectivity returns,
 *  once on startup (a reload while online may have left persisted ops), and
 *  on a 30s sweep — catches transient 5xx replays and the case where the
 *  server came back without a connectivity transition ever firing. */
export function useOfflineReplay() {
  const qc = useQueryClient();
  useEffect(() => {
    if (!isOffline() && getQueuedOps().length > 0) void replayQueuedOps(qc);
    const sweep = window.setInterval(() => {
      if (!isOffline() && getQueuedOps().some((o) => o.status === 'queued')) {
        void replayQueuedOps(qc);
      }
    }, 30_000);
    const unsub = subscribeConnectivity((mode) => {
      if (mode !== 'offline') void replayQueuedOps(qc);
    });
    return () => {
      unsub();
      window.clearInterval(sweep);
    };
  }, [qc]);
}

// =========================================================================
// Bug / issue reporting (0038)
//
// Any member can file a report (bug/idea/question/other) with optional
// screenshots via one multipart request. They can read back their own
// submissions to watch the status. Platform super-admins triage everything
// through the /super hooks below. Screenshots are private — fetched as authed
// blobs into object URLs (mirrors fetchStaffDocBlob), never via a public URL.
// =========================================================================




/** Submit a report + screenshots as one multipart POST. Returns the new id and
 *  a short human reference ("A1B2C3") shown on the success screen. */
export function useSubmitBugReport() {
  const { slug } = useTenant();
  const qc = useQueryClient();
  return useMutation<{ id: string; ref: string }, ApiError, BugReportInput>({
    mutationFn: async (input) => {
      const fd = new FormData();
      fd.append('kind', input.kind);
      if (input.mood) fd.append('mood', String(input.mood));
      if (input.title) fd.append('title', input.title);
      fd.append('description', input.description);
      fd.append('page_url', window.location.href);
      fd.append('app_version', __APP_VERSION__);
      fd.append('user_agent', navigator.userAgent);
      fd.append('viewport', `${window.innerWidth}x${window.innerHeight}`);
      for (const f of input.files) fd.append('files', f);

      const at = getAccessToken();
      const res = await fetch(url('/v1/bug-reports'), {
        method: 'POST',
        headers: { 'X-Tenant-ID': slug!, ...(at ? { Authorization: `Bearer ${at}` } : {}) },
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
      return (await res.json()) as { id: string; ref: string };
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bug-reports', 'mine'] }),
  });
}

export function useMyBugReports(enabled = true) {
  const { slug } = useTenant();
  return useQuery<MyBugReport[], ApiError>({
    queryKey: ['bug-reports', 'mine', slug],
    enabled: enabled && !!slug,
    queryFn: () =>
      request<ListResp<'reports', MyBugReport>>('GET', '/v1/bug-reports/mine', {
        tenantSlug: slug!,
      }).then((r) => r.reports),
  });
}

// ---- super-admin triage ----






export function useAdminBugReports(filters: BugReportFilters = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return useQuery<AdminBugReportsResponse, ApiError>({
    queryKey: ['super', 'bug-reports', filters],
    queryFn: () => request('GET', `/v1/super/bug-reports${qs ? `?${qs}` : ''}`),
  });
}

export function useAdminBugReport(id: string | undefined) {
  return useQuery<AdminBugReportDetail, ApiError>({
    queryKey: ['super', 'bug-report', id],
    enabled: !!id,
    queryFn: () => request('GET', `/v1/super/bug-reports/${id}`),
  });
}

function useSuperBugMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation<unknown, ApiError, V>({
    mutationFn: fn as (v: V) => Promise<unknown>,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['super', 'bug-reports'] });
      qc.invalidateQueries({ queryKey: ['super', 'bug-report'] });
    },
  });
}

export function useAdminUpdateBugReport(id: string) {
  return useSuperBugMutation<{ status?: string; priority?: string; resolution_note?: string }>(
    (body) => request('PATCH', `/v1/super/bug-reports/${id}`, { body }),
  );
}

export function useAdminDeleteBugReport() {
  return useSuperBugMutation<{ id: string }>(({ id }) =>
    request('POST', `/v1/super/bug-reports/${id}/delete`),
  );
}

/** Stream a private screenshot into an object URL, with the same 401-refresh
 *  retry as fetchStaffDocBlob. `scope` picks the tenant vs super proxy. */
export async function fetchBugAttachmentBlob(
  scope: { kind: 'tenant'; slug: string } | { kind: 'super' },
  reportId: string,
  attId: string,
  retried = false,
): Promise<string> {
  const path =
    scope.kind === 'super'
      ? `/v1/super/bug-reports/${reportId}/attachments/${attId}`
      : `/v1/bug-reports/${reportId}/attachments/${attId}`;
  const at = getAccessToken();
  const res = await fetch(url(path), {
    headers: {
      ...(scope.kind === 'tenant' ? { 'X-Tenant-ID': scope.slug } : {}),
      ...(at ? { Authorization: `Bearer ${at}` } : {}),
    },
  });
  if (res.status === 401 && !retried && getRefreshToken()) {
    const result = await refreshTokens();
    if (result === 'ok') return fetchBugAttachmentBlob(scope, reportId, attId, true);
    if (result === 'invalid') handleUnauthenticated();
  }
  if (!res.ok) throw { status: res.status, message: res.statusText } as ApiError;
  return URL.createObjectURL(await res.blob());
}

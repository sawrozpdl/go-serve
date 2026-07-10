// Permission-driven UI gating.
//
// The backend RBAC is the single source of truth: `GET /v1/me` returns the
// active membership's flattened grant set (`active_permissions`, including
// wildcard tokens like `order:*` / `*:*`). Everything here derives purely from
// that set — there are NO hardcoded role-name checks. If an owner grants a
// custom role a permission via the Roles editor, the matching UI appears
// automatically; if they revoke it, the UI disappears. The UI never shows a
// control the active member cannot actually use.
import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import type { Permission } from '@cafe-mgmt/rbac';

import { useMe, can as canFn, canAny as canAnyFn, isSystemOwner, isPlatformAdmin, type Me } from './api';

/** Bound permission checks for the active tenant. Reads the cached `useMe()`. */
export function usePermissions() {
  const me = useMe();
  const data = me.data;
  return {
    me: data,
    isLoading: me.isPending,
    isOwner: isSystemOwner(data),
    /** Holds `want` (exact, resource wildcard, or `*:*`). */
    can: (want: Permission) => canFn(data, want),
    /** Holds at least one of `wants`. */
    canAny: (...wants: Permission[]) => canAnyFn(data, ...wants),
  };
}

type GateProps = {
  /** Single permission required to render `children`. */
  perm?: Permission;
  /** Render `children` if the member holds ANY of these. */
  anyOf?: Permission[];
  children: ReactNode;
  /** Rendered instead of `children` when the check fails (default: nothing). */
  fallback?: ReactNode;
};

/**
 * Render-gate: shows `children` only when the active member holds the required
 * permission. Use to hide action controls a member can't use, e.g.
 *   <Can perm="order:settle"><button>Settle</button></Can>
 */
export function Can({ perm, anyOf, children, fallback = null }: GateProps) {
  const { can, canAny } = usePermissions();
  const ok = perm ? can(perm) : anyOf && anyOf.length > 0 ? canAny(...anyOf) : false;
  return <>{ok ? children : fallback}</>;
}

/**
 * Route guard: renders `children` only if the member holds the permission,
 * otherwise bounces to the member's best available landing (`/admin`, which
 * itself resolves to the dashboard or the first accessible section). This is a
 * UX/defense-in-depth layer — the API still enforces every request — so a
 * member can't reach a page by typing its URL.
 */
export function RequirePermission({
  perm,
  anyOf,
  children,
}: {
  perm?: Permission;
  anyOf?: Permission[];
  children: ReactNode;
}) {
  const { can, canAny, isLoading } = usePermissions();
  if (isLoading) {
    return (
      <div className="login-shell">
        <div className="empty-state">Loading…</div>
      </div>
    );
  }
  const ok = perm ? can(perm) : anyOf && anyOf.length > 0 ? canAny(...anyOf) : true;
  if (!ok) return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

/**
 * Route guard for the /super console. Renders `children` only for site-wide
 * platform admins (independent of tenant RBAC); everyone else is bounced to
 * the app. Defense-in-depth — the API enforces platform-admin on every /super
 * request regardless.
 */
export function RequirePlatformAdmin({ children }: { children: ReactNode }) {
  const me = useMe();
  if (me.isPending) {
    return (
      <div className="login-shell">
        <div className="empty-state">Loading…</div>
      </div>
    );
  }
  if (!isPlatformAdmin(me.data)) return <Navigate to="/admin" replace />;
  return <>{children}</>;
}

/**
 * The path a member should land on when they have no dashboard access, or when
 * they're bounced off a page they can't see. Walks the primary sections in
 * priority order and returns the first the member can reach; `null` when the
 * member can reach nothing (a misconfigured custom role with no readable
 * section) — callers should show a friendly "no access" state.
 */
export function landingPath(me: Me | undefined): string | null {
  const order: [Permission, string][] = [
    ['order:read', '/admin/floor'],
    ['kitchen:read', '/admin/kitchen'],
    ['inventory:read', '/admin/inventory'],
    ['expense:read', '/admin/expenses'],
    ['house_tab:read', '/admin/house-tabs'],
    ['account:read', '/admin/accounts'],
    ['finance:read', '/admin/owners'],
    ['member:read', '/admin/people/members'],
    ['audit:read', '/admin/activity'],
  ];
  for (const [perm, path] of order) {
    if (canFn(me, perm)) return path;
  }
  return null;
}

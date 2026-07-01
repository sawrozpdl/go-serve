/**
 * Permission checks + role-based landing, built on the shared @cafe-mgmt/rbac
 * manifest so mobile and the Go API agree on grant semantics. Pure + testable.
 */
import { matches } from '@cafe-mgmt/rbac';
import type { Me } from '@cafe-mgmt/api-types';

/** True if the active-tenant grant set satisfies `perm` (exact or wildcard). */
export function can(me: Me | null | undefined, perm: string): boolean {
  if (!me) return false;
  return matches(me.active_permissions ?? [], perm);
}

/** True if the user holds an active membership on the given tenant slug. */
export function hasActiveMembership(me: Me | null | undefined, slug: string): boolean {
  return !!me?.memberships.some((m) => m.tenant_slug === slug && m.status === 'active');
}

/** Active memberships only — what the workspace picker should list. */
export function activeMemberships(me: Me | null | undefined) {
  return (me?.memberships ?? []).filter((m) => m.status === 'active');
}

export type LandingTab = 'floor' | 'kitchen' | 'history';

/**
 * Where to drop the user after auth, by capability. Kitchen-only staff (can see
 * the kitchen board but can't take orders) land on the kitchen; anyone who can
 * work the floor lands there; a read-only viewer lands on history. Mirrors the
 * spirit of web's default-landing redirect.
 */
export function landingTab(me: Me | null | undefined): LandingTab {
  if (can(me, 'order:create') || can(me, 'order:read')) return 'floor';
  if (can(me, 'kitchen:read') || can(me, 'kitchen:update')) return 'kitchen';
  return 'history';
}

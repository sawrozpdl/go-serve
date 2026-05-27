// Shared RBAC manifest + helpers. Source of truth is `permissions.json` —
// both the Go API (via //go:embed) and this TypeScript surface load the
// same file. Adding/renaming a permission requires editing only that JSON.

import manifestJSON from '../permissions.json' with { type: 'json' };

export type Manifest = typeof manifestJSON;

export type Permission = (typeof manifestJSON.permissions)[number]['key'];
export type ResourceKey = (typeof manifestJSON.resources)[number]['key'];
export type SystemRoleKey = (typeof manifestJSON.system_roles)[number]['key'];

export type PermissionDef = (typeof manifestJSON.permissions)[number];
export type ResourceDef = (typeof manifestJSON.resources)[number];
export type SystemRoleDef = (typeof manifestJSON.system_roles)[number];

export const manifest: Manifest = manifestJSON;
export const PERMISSIONS: readonly PermissionDef[] = manifestJSON.permissions;
export const RESOURCES: readonly ResourceDef[] = manifestJSON.resources;
export const SYSTEM_ROLES: readonly SystemRoleDef[] = manifestJSON.system_roles;

const PERMISSION_KEY_SET: ReadonlySet<string> = new Set(
  manifestJSON.permissions.map((p) => p.key),
);

/** True if `key` is a known permission in the manifest. */
export function isKnownPermission(key: string): key is Permission {
  return PERMISSION_KEY_SET.has(key);
}

/**
 * True if the held set grants `want`. Pure allow-list semantics:
 *   - exact match (e.g. `menu:create`)
 *   - resource wildcard (e.g. `menu:*`)
 *   - global wildcard (`*:*`)
 * No precedence — any one of the three is sufficient.
 */
export function matches(have: ReadonlySet<string> | readonly string[], want: string): boolean {
  const set = have instanceof Set ? have : new Set(have);
  if (set.has(want) || set.has('*:*')) return true;
  const colon = want.indexOf(':');
  if (colon === -1) return false;
  return set.has(`${want.slice(0, colon)}:*`);
}

/** Group permissions by resource — useful for rendering checkbox trees. */
export function groupByResource(): Array<{ resource: ResourceDef; permissions: PermissionDef[] }> {
  return manifestJSON.resources.map((resource) => ({
    resource,
    permissions: manifestJSON.permissions.filter((p) => p.resource === resource.key),
  }));
}

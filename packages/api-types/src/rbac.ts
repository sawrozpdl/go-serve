// Roles, permissions manifest, members, and invites.
import type { TenantRole } from './auth';

export type PermissionDef = {
  key: string;
  resource: string;
  action: string;
  label: string;
  description: string;
};

export type ResourceDef = { key: string; label: string; description: string };

export type SystemRoleDef = {
  key: string;
  name: string;
  description: string;
  locked: boolean;
  permissions: string[];
};

export type PermissionManifest = {
  version: number;
  resources: ResourceDef[];
  permissions: PermissionDef[];
  system_roles: SystemRoleDef[];
};

export type Role = {
  id: string;
  key: string;
  name: string;
  description: string;
  is_system: boolean;
  /** True for the owner system role; it cannot be edited or deleted. */
  locked: boolean;
  /** Grant tokens (exact, "resource:*", or "*:*"). */
  permissions: string[];
  member_count: number;
};

export type Member = {
  user_id: string;
  email: string;
  name: string;
  roles: TenantRole[];
  status: 'active' | 'pending' | 'suspended';
};

export type Invite = {
  id: string;
  email: string;
  roles: TenantRole[];
  invited_at: string;
  invited_by_user_id?: string | null;
};

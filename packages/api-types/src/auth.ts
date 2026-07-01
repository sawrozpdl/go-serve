// Auth, session, and identity DTOs.

/** Login / refresh / exchange response shape. */
export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  access_expires_in: number;
  user_id: string;
  session_id: string;
};

export type ApiError = {
  status: number;
  message: string;
  code?: string;
  /** Set by /auth/request-otp when the per-email cooldown is still active. */
  retry_after_seconds?: number;
  /** Set by /auth/verify-otp on a wrong code that hasn't hit the attempt cap. */
  attempts_remaining?: number;
  /** Set by DELETE /v1/me (code 'sole_owner') — slugs where the user is the only owner. */
  workspaces?: string[];
};

/** A role key — either one of the four system keys or a tenant-defined custom key. */
export type TenantRole = string;

export type Membership = {
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  /** Every role key the user holds on this tenant. */
  roles: TenantRole[];
  status: 'active' | 'pending' | 'suspended';
};

/** Plan snapshot for the active tenant, included on /me. Drives the trial /
 *  write-lock banners and feature gating without an extra request. */
export type BillingInfo = {
  plan_key: string;
  /** active | trial | grace | expired | locked */
  phase: string;
  trial_ends_at?: string;
  write_locked: boolean;
  /** null = unlimited */
  member_limit: number | null;
  /** active members + pending invites */
  seats_used: number;
  /** effective feature keys included on this plan */
  features: string[];
};

export type Me = {
  user_id: string;
  email: string;
  name: string;
  active_tenant_slug?: string;
  /** Legacy alias for active_role_keys — kept for components that read it. */
  active_roles?: TenantRole[];
  /** Role keys held on the active tenant. */
  active_role_keys?: TenantRole[];
  /** Flattened grant set on the active tenant (exact + wildcard tokens). */
  active_permissions?: string[];
  memberships: Membership[];
  /** True if the user is a site-wide super admin (drives the /super nav). */
  is_platform_admin?: boolean;
  /** Active tenant's plan snapshot (present only with a tenant context). */
  billing?: BillingInfo;
};

export type AuthConfig = {
  google_enabled: boolean;
  dev_login_enabled: boolean;
  email_otp_enabled: boolean;
};

export type RequestOTPResponse = {
  sent: boolean;
  expires_in_seconds: number;
  resend_in_seconds: number;
};

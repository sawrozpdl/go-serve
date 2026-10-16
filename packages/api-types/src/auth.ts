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
  /** The business the active café is a branch of. Absent for a standalone café. */
  business?: BusinessInfo;
  /** Branches of that business the user can enter (includes the active one). */
  branches?: Branch[];
};

/** A business groups several cafés as its branches (migration 0088). */
export type BusinessInfo = {
  id: string;
  name: string;
};

/** What the user may do in a branch — loaded per branch, so custom roles are exact. */
export type BranchCan = {
  report_read: boolean;
  finance_read: boolean;
  menu_update: boolean;
  inventory_adjust: boolean;
};

/** One branch (= one café / tenant) of the active business. */
export type Branch = {
  tenant_id: string;
  slug: string;
  name: string;
  timezone: string;
  roles: TenantRole[];
  /** True for the branch the request was made in. */
  is_active: boolean;
  /** Present on GET /v1/business/branches, absent on /me. */
  can?: BranchCan;
};

export type BusinessBranchesResponse = {
  business: BusinessInfo | null;
  branches: Branch[];
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

/** How one branch fared in an all-branches report. */
export type BranchStatus = {
  tenant_id: string;
  slug: string;
  name: string;
  timezone: string;
  /** ok | forbidden | plan_upgrade_required | not_found | error */
  status: 'ok' | 'forbidden' | 'plan_upgrade_required' | 'not_found' | 'error';
  error_code?: string;
};

/** One branch's own answer inside an all-branches report. */
export type BranchData<T> = {
  tenant_id: string;
  slug: string;
  name: string;
  data: T;
};

/** GET /v1/business/reports/* — each branch's own report, plus their sum. */
export type FanoutResponse<T> = {
  business: BusinessInfo | null;
  branches: BranchStatus[];
  /** Every requested branch answered; otherwise totals cover only the `ok` ones. */
  complete: boolean;
  mixed_timezones: boolean;
  totals: T;
  per_branch: BranchData<T>[];
};

/** POST /v1/business/stock-transfers */
export type StockTransferPayload = {
  to: string;
  lines: { inventory_item_id: string; qty_units: string }[];
  note?: string;
};

export type StockTransferResult = {
  id: string;
  from: BranchStatus;
  to: BranchStatus;
  lines: {
    item: string;
    sale_unit: string;
    qty_units: string;
    from_item_id: string;
    to_item_id: string;
    created_at_destination: boolean;
  }[];
};

/** One transfer as this branch saw it (GET /v1/business/stock-transfers). */
export type StockTransferRow = {
  id: string;
  at: string;
  direction: 'in' | 'out';
  note: string;
  lines: { item: string; sale_unit: string; qty_units: string }[];
};

/** GET /v1/business/credit — credit accounts linked across branches by phone. */
export type CreditAccount = {
  tenant_id: string;
  branch_slug: string;
  branch_name: string;
  house_tab_id: string;
  name: string;
  is_active: boolean;
  balance_cents: number;
};

export type CreditCustomer = {
  key: string;
  name: string;
  phone: string;
  /** Matched across branches by phone. False = a single account with no phone. */
  linked: boolean;
  balance_cents: number;
  accounts: CreditAccount[];
};

export type BusinessCreditResponse = {
  business: BusinessInfo | null;
  branches: BranchStatus[];
  complete: boolean;
  customers: CreditCustomer[];
  total_owed_cents: number;
};

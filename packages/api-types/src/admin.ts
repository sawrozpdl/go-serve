// Super-admin / platform console DTOs (plans, tenants, payments, requests).
export type WriteLockState = { locked: boolean; phase: string; note?: string };

export type TrialState = {
  phase: string; // active | trial | grace | expired | locked
  endsAt?: string;
  daysLeft?: number; // remaining whole days (negative once past)
};

export type AdminTenant = {
  tenant_id: string;
  slug: string;
  name: string;
  status: string;
  billing_state: string;
  plan_key: string;
  plan_name: string;
  member_limit: number | null;
  trial_ends_at?: string;
  active_members: number;
  pending_invites: number;
  owner_email?: string;
  created_at: string;
  last_activity?: string;
  paid_through_at?: string;
  last_payment_at?: string;
  contact_phone: string;
};

export type AdminTenantsResponse = {
  tenants: AdminTenant[];
  summary: {
    total: number;
    active: number;
    trials_expiring_soon: number;
    past_due: number;
    by_plan: Record<string, number>;
  };
};

export type AdminTenantDetail = AdminTenant & {
  member_limit_override: number | null;
  feature_overrides: { grant?: string[]; revoke?: string[] } | null;
  billing_note: string;
  timezone: string;
};

/** One manually-recorded payment in a tenant's history. */
export type AdminPayment = {
  id: string;
  amount_cents: number;
  currency: string;
  method: 'cash' | 'bank' | 'online' | 'other';
  period_start?: string;
  period_end: string;
  note: string;
  recorded_by?: string;
  recorded_name?: string;
  created_at: string;
};

export type RecordPaymentInput = {
  amount_cents: number;
  currency?: string;
  method: 'cash' | 'bank' | 'online' | 'other';
  period_start?: string;
  period_end: string;
  note?: string;
};

/** Per-category row counts a purge would remove, plus whether the acting admin
 *  is themselves a member of this tenant (drives the "deleting your own
 *  workspace" warning). */
export type PurgeScope = 'logs' | 'transactions' | 'menu' | 'tables' | 'house_tabs' | 'owners' | 'inventory' | 'staff';

export type TenantDataSummary = {
  counts: Record<PurgeScope, number>;
  you_are_member: boolean;
  active_members: number;
};

export type AdminPlan = {
  id: string;
  key: string;
  name: string;
  member_limit: number | null;
  trial_days: number;
  price_copy: string;
  is_enterprise: boolean;
  sort_order: number;
  active: boolean;
  features: string[];
};

export type PlanInput = {
  key: string;
  name: string;
  member_limit: number | null;
  trial_days: number;
  price_copy: string;
  is_enterprise: boolean;
  sort_order: number;
  active: boolean;
  features: string[];
};

export type FeatureDef = {
  key: string;
  label: string;
  desc: string;
  group: string;
  /** Excluded from the trial blanket grant; off unless explicitly granted. */
  default_off?: boolean;
};

export type AdminTenantRequest = {
  id: string;
  name: string;
  cafe_name: string;
  email: string;
  phone: string;
  desired_plan: string;
  message: string;
  state: 'pending' | 'approved' | 'rejected';
  provisioned_tenant_id?: string;
  review_note: string;
  created_at: string;
  reviewed_at?: string;
};

export type PlatformAdminEntry = { user_id: string; email: string; name: string; source: string; created_at: string };

export type PlatformAuditEvent = {
  actor_email: string;
  action: string;
  tenant_id?: string;
  tenant_slug?: string;
  target_id: string;
  summary: string;
  created_at: string;
};

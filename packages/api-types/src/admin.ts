// Super-admin / platform console DTOs (plans, tenants, payments, requests).
export type WriteLockState = { locked: boolean; phase: string; note?: string };

export type TrialState = {
  phase: string; // active | trial | grace | expired | locked
  endsAt?: string;
  daysLeft?: number; // remaining whole days (negative once past)
};

/** How a cafe came to us. Mirrors the CHECK on tenants.acquisition_source. */
export type AcquisitionSource = 'direct' | 'request_access' | 'referral' | 'walk_in' | 'other';

export const ACQUISITION_SOURCES: { value: AcquisitionSource; label: string }[] = [
  { value: 'direct', label: 'Direct' },
  { value: 'request_access', label: 'Request form' },
  { value: 'referral', label: 'Referral' },
  { value: 'walk_in', label: 'Walk-in' },
  { value: 'other', label: 'Other' },
];

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
  /** max(audit_log.created_at) — NULL when the tenant lacks the default-off
   *  audit_logs feature, which is most of them. Means "not recording", NOT
   *  "inactive": use the usage rollup for that. */
  last_activity?: string;
  paid_through_at?: string;
  last_payment_at?: string;
  contact_phone: string;
  // Relationship (0057/0058).
  owner_name: string;
  onboarded_on?: string;
  acquisition_source: AcquisitionSource;
  onboarded_by_person_id?: string;
  onboarded_by_name?: string;
  relationship_manager_id?: string;
  relationship_manager_name?: string;
};

/** Someone who onboards or looks after cafes. Not an auth record: a market
 *  agent with no email and no login is a valid entry. */
export type PlatformPerson = {
  id: string;
  name: string;
  kind: 'admin' | 'agent' | 'partner';
  email?: string;
  phone: string;
  user_id?: string;
  active: boolean;
  notes: string;
  created_at: string;
  cafes_onboarded: number;
  cafes_managed: number;
  /** True only when they're in platform_admins — being in the registry grants
   *  nothing on its own. */
  console_access: boolean;
};

export type PersonInput = {
  name: string;
  kind: PlatformPerson['kind'];
  email?: string | null;
  phone?: string;
  notes?: string;
  active?: boolean;
};

export type PortfolioCafe = {
  tenant_id: string;
  slug: string;
  name: string;
  status: string;
  plan_name?: string;
  onboarded_on?: string;
};

export type PersonPortfolio = {
  person: PlatformPerson;
  /** Cafes they currently manage. */
  cafes: PortfolioCafe[];
  /** Cafes they originally signed up (may now be managed by someone else). */
  onboards: PortfolioCafe[];
};

/** One entry in a cafe's internal CRM timeline. Never shown to the cafe. */
export type TenantNote = {
  id: string;
  body: string;
  pinned: boolean;
  author_name: string;
  created_at: string;
};

export type RelationshipInput = {
  onboarded_by_person_id: string | null;
  relationship_manager_id: string | null;
  /** Distinguishes "omitted, default the RM to the onboarder" from
   *  "explicitly unassigned". A bare null can't express the difference. */
  rm_provided: boolean;
  onboarded_on?: string | null;
  acquisition_source: AcquisitionSource;
  owner_name: string;
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

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

/* --- Usage health (0059) ------------------------------------------------
 *
 * Deliberately separate from billing state. "Trial expiring" and "stopped
 * closing shifts" are different problems for different people, so the console
 * shows them in two columns rather than one blended score.
 */

export type UsageStatus = 'onboarding' | 'healthy' | 'watch' | 'at_risk' | 'dormant';
export type SignalGrade = 'good' | 'warn' | 'bad' | 'na';

export const USAGE_STATUS_LABEL: Record<UsageStatus, string> = {
  onboarding: 'Onboarding',
  healthy: 'Healthy',
  watch: 'Watch',
  at_risk: 'At risk',
  dormant: 'Dormant',
};

/** Pill class for a usage status. '' renders as the neutral/bad pill. */
export const USAGE_STATUS_PILL: Record<UsageStatus, '' | 'ok' | 'warn'> = {
  onboarding: '',
  healthy: 'ok',
  watch: 'warn',
  at_risk: '',
  dormant: '',
};

export type UsageSignal = {
  key: 'shift_discipline' | 'volume' | 'engagement';
  grade: SignalGrade;
  /** Human sentence with the actual numbers — never show a bare colour. */
  detail: string;
  value: number;
};

export type TenantUsage = {
  tenant_id: string;
  status: UsageStatus;
  /** Signal keys that pushed the status away from healthy. */
  reasons: string[];
  signals: UsageSignal[];
  last_order_closed_at?: string;
  orders_7d: number;
  orders_prev_28d: number;
  gross_7d_cents: number;
  last_shift_closed_at?: string;
  open_shift_since?: string;
  operating_days_7d: number;
  shift_closed_days_7d: number;
  active_members_7d: number;
  menu_item_count: number;
  adoption: {
    inventory: boolean;
    expenses: boolean;
    credit: boolean;
    staff: number;
    outlets: number;
  };
};

export type UsageResponse = {
  usage: TenantUsage[];
  by_status: Partial<Record<UsageStatus, number>>;
};

export type ShiftLogEntry = {
  id: string;
  opened_at: string;
  closed_at?: string;
  closed_by_name?: string;
  variance_cents?: number;
};

/** One day of the usage sparkline, from the nightly snapshot. Named for its
 *  domain because reports/ already exports an unrelated DailyPoint. */
export type UsageDailyPoint = {
  day: string;
  orders: number;
  gross_cents: number;
  status: UsageStatus;
};

export type TenantUsageDetail = {
  usage: TenantUsage;
  trend: UsageDailyPoint[];
  shifts: ShiftLogEntry[];
};

/* --- Platform books (0060) ----------------------------------------------- */

/** Where a payment physically landed. Distinct from `method`, which records how
 *  it was paid: cash into a person's hands creates a custody obligation. */
export type ReceivedInto = 'cash' | 'bank' | 'wallet';

/** Where an expense's money came from. 'person_cash' draws down that person's
 *  custody balance. */
export type PaidFrom = 'bank' | 'wallet' | 'person_cash';

export type CashKind = 'collection' | 'deposit_to_bank' | 'expense' | 'handover_out' | 'handover_in';

export const CASH_KIND_LABEL: Record<CashKind, string> = {
  collection: 'Collected',
  deposit_to_bank: 'Banked',
  expense: 'Spent',
  handover_out: 'Handed over',
  handover_in: 'Received',
};

/** Whether a movement adds to or draws down the holder's balance. */
export const CASH_KIND_SIGN: Record<CashKind, 1 | -1> = {
  collection: 1,
  handover_in: 1,
  deposit_to_bank: -1,
  expense: -1,
  handover_out: -1,
};

export type CashHolder = {
  person_id: string;
  name: string;
  active: boolean;
  held_cents: number;
  /** When their oldest un-cleared collection came in — an old date means money
   *  has been sitting in a bag for a while. */
  oldest_held_at?: string;
};

export type CashEntry = {
  id: string;
  person_id: string;
  person_name: string;
  kind: CashKind;
  amount_cents: number;
  occurred_at: string;
  counterparty_name?: string;
  cafe_name?: string;
  reference_no: string;
  notes: string;
};

export type CashResponse = {
  holders: CashHolder[];
  entries: CashEntry[];
  total_held_cents: number;
};

export type PlatformExpense = {
  id: string;
  category_id?: string;
  category_name?: string;
  amount_cents: number;
  currency: string;
  occurred_on: string;
  vendor: string;
  note: string;
  paid_from: PaidFrom;
  paid_by_person_id?: string;
  paid_by_name?: string;
  tenant_id?: string;
  cafe_name?: string;
  created_at: string;
};

export type PlatformExpenseInput = {
  category_id?: string | null;
  amount_cents: number;
  occurred_on: string;
  vendor?: string;
  note?: string;
  paid_from: PaidFrom;
  paid_by_person_id?: string | null;
  tenant_id?: string | null;
};

export type PlatformExpenseCategory = {
  id: string;
  name: string;
  icon: string;
  sort_order: number;
  active: boolean;
};

export type RevenueRow = {
  id: string;
  tenant_id: string;
  cafe_name: string;
  plan_name?: string;
  amount_cents: number;
  currency: string;
  method: 'cash' | 'bank' | 'online' | 'other';
  received_into: ReceivedInto;
  collected_by_name?: string;
  period_end: string;
  note: string;
  created_at: string;
};

export type RevenueResponse = {
  payments: RevenueRow[];
  total_cents: number;
  by_method: Record<string, number>;
  by_collector: Record<string, number>;
  by_month: Record<string, number>;
};

export type StatementResponse = {
  from: string;
  to: string;
  revenue_cents: number;
  expenses_cents: number;
  net_cents: number;
  expenses_by_category: Record<string, number>;
  /** All-time, not range-bound: "how much is in the bank right now" is not a
   *  property of a date range. Cash held by people is reported separately — it
   *  is real money we own but cannot spend from an account. */
  cash_position: {
    bank_cents: number;
    wallet_cents: number;
    held_by_people_cents: number;
  };
};

/* --- Money-accuracy self-check (0056) ------------------------------------ */

export type AccuracyViolation = {
  tenant_id: string;
  slug: string;
  check_key: string;
  entity: string;
  entity_id: string;
  detail: string;
  delta_cents: number;
};

export type AccuracyCheckSummary = {
  check_key: string;
  count: number;
  total_delta_cents: number;
  /** Plain-English meaning, so a report reads without the migration open. */
  means: string;
};

export type AccuracyCheckResponse = {
  healthy: boolean;
  scope: string;
  /** Complete counts. Prefer these over `violations.length`, which is capped. */
  summary: AccuracyCheckSummary[];
  violations: AccuracyViolation[];
  truncated: boolean;
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
  /** Who physically took the money (0060). Omit and the server defaults it to
   *  whoever is recording the payment — for cash, that's usually the same
   *  person. Only cash creates a custody obligation. */
  collected_by_person_id?: string;
  /** Where it landed. Derived from `method` when omitted. */
  received_into?: ReceivedInto;
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

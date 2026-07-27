/* Pricing — single source of truth for the /pricing table, the home
 * teaser, and the SoftwareApplication JSON-LD offers.
 *
 * NOTE: these are marketing figures. The backend `plans` table still
 * gates by seat count and grants all features to every tier today; wiring
 * these exact prices/limits into `plan_features` + `price_copy` is a
 * separate backend task (see the plan's "out of scope" note). */

export const CURRENCY = 'NPR';
export const TRIAL_DAYS = 30;
export const TRIAL_COPY = '1-month free trial — no card required';

/* Launch promotion — temporary, yearly billing only.
 *
 * Set `active: false` to retire the offer everywhere at once: the announcement
 * bar, the struck-through list prices, the savings pills, the FAQ copy and the
 * JSON-LD offers all read from here. No end date is published, so nothing here
 * expires on its own and nothing emits `priceValidUntil`. */
export const LAUNCH = {
  active: true,
  /** Badge on a discounted plan card. */
  badge: 'Launch price',
  /** Announcement-bar headline. */
  headline: 'Launch offer — save up to Rs 3,000 on your first year',
  /** Announcement-bar supporting line. */
  sub: 'New cafes only. Standard Rs 10,000, Premium Rs 15,000, billed yearly.',
} as const;

export type BillingCycle = 'yearly' | 'monthly';

export type Plan = {
  key: string;
  name: string;
  tagline: string;
  /** Who it's for — one line under the name. */
  summary: string;
  /** List price when billed yearly, in whole NPR. null = custom/contact.
   *  This stays the *undiscounted* figure — it's what gets struck through
   *  while LAUNCH is active. Read `effectiveYearly(p)` for what we charge. */
  yearly: number | null;
  /** Price per month when billed monthly, in whole NPR. null = custom.
   *  Never discounted: the launch offer is yearly-only. */
  monthly: number | null;
  /** Launch price when billed yearly. Omitted = this tier isn't discounted. */
  launchYearly?: number;
  featured?: boolean;
  cta: { label: string; action: 'trial' | 'contact' };
  /** Intro line before the feature list (e.g. inheritance). */
  inherits?: string;
  features: string[];
};

export const PLANS: Plan[] = [
  {
    key: 'standard',
    name: 'Standard',
    tagline: 'Get selling',
    summary: 'A single cafe finding its feet.',
    yearly: 12000,
    monthly: 1200,
    launchYearly: 10000,
    cta: { label: 'Start free trial', action: 'trial' },
    features: [
      'Up to 3 staff logins',
      'Up to 50 tables',
      'Up to 500 menu items, categories',
      'Orders, live floor & kitchen tickets',
      'Public QR menu',
      'KOT/BOT Management',
      'Daily sales reports & shift close',
      'Merge/Move tables',
      'Walk-In Tabs',
      'Full transaction history',
      'Cash drawer & expenses',
      'Customer credit / house tabs',
      '13% VAT + service charge · eSewa & Khalti',
    ],
  },
  {
    key: 'premium',
    name: 'Premium',
    tagline: 'Run the whole floor',
    summary: 'A busy cafe running full service.',
    yearly: 18000,
    monthly: 1800,
    launchYearly: 15000,
    featured: true,
    cta: { label: 'Start free trial', action: 'trial' },
    inherits: 'Everything in Standard, plus',
    features: [
      'Unlimited staff logins',
      'Unlimited tables, menu items, categories',
      'Inventory & low-stock alerts/notifications',
      'Owner finance — equity, loans, payouts',
      'Advanced analytics & profitability (P&L, heatmaps)',
      'Staff records, scheduling & custom roles',
      'Email shift summaries',
      'Priority support',
    ],
  },
  {
    key: 'enterprise',
    name: 'Enterprise',
    tagline: 'Multi-outlet & beyond',
    summary: 'Groups, franchises, multiple locations.',
    yearly: null,
    monthly: null,
    cta: { label: 'Talk to sales', action: 'contact' },
    inherits: 'Everything in Premium, plus',
    features: [
      'Multiple outlets & prep stations',
      'Custom feature requests',
      'Audit logs',
      'Dedicated onboarding & training',
      'SLA + phone support',
      'Custom domain & branding',
      'API & webhooks',
    ],
  },
];

const rs = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
/** "Rs 12,000" */
export const formatRs = (n: number) => `Rs ${rs.format(n)}`;

/** What a yearly plan actually costs today — the launch price while the offer
 *  is running, otherwise the list price. Every price on the site goes through
 *  this, including the JSON-LD offers. */
export const effectiveYearly = (p: Plan): number | null =>
  LAUNCH.active && p.launchYearly != null ? p.launchYearly : p.yearly;

/** The crossed-out original, or null when this tier isn't discounted. */
export const listYearly = (p: Plan): number | null =>
  LAUNCH.active && p.launchYearly != null && p.yearly != null ? p.yearly : null;

/** Rupees off the first year, or 0 when not discounted. */
export const launchSaving = (p: Plan): number => {
  const was = listYearly(p);
  const now = effectiveYearly(p);
  return was != null && now != null ? was - now : 0;
};

/** Rupees saved by paying yearly instead of monthly, at today's prices. */
export const yearlySavings = (p: Plan) => {
  const y = effectiveYearly(p);
  return y != null && p.monthly != null ? p.monthly * 12 - y : 0;
};

/** Rounded % saved by paying yearly instead of monthly, at today's prices. */
export const yearlySavingsPct = (p: Plan) => {
  const y = effectiveYearly(p);
  return y != null && p.monthly != null ? Math.round((1 - y / (p.monthly * 12)) * 100) : 0;
};

/** Whole months of monthly billing covered by the yearly saving, rounded down.
 *  Computed rather than hardcoded because a yearly-only launch discount changes
 *  it — "save 2 months" becomes 3 at launch prices. Uses the best paid tier so
 *  one figure fits the billing-cycle toggle. */
export const savedMonths = (): number => {
  const months = PLANS.map((p) => (p.monthly != null ? yearlySavings(p) / p.monthly : 0));
  return Math.floor(Math.max(0, ...months));
};

/** "save 3 months" — the label on the Yearly toggle. */
export const savedMonthsCopy = (): string => {
  const n = savedMonths();
  return n >= 2 ? `save ${n} months` : 'save more';
};

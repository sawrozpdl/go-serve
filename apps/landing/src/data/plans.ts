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

export type BillingCycle = 'yearly' | 'monthly';

export type Plan = {
  key: string;
  name: string;
  tagline: string;
  /** Who it's for — one line under the name. */
  summary: string;
  /** Price when billed yearly, in whole NPR. null = custom/contact. */
  yearly: number | null;
  /** Price per month when billed monthly, in whole NPR. null = custom. */
  monthly: number | null;
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
    featured: true,
    cta: { label: 'Start free trial', action: 'trial' },
    inherits: 'Everything in Basic, plus',
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
    inherits: 'Everything in Business, plus',
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
/** "Rs 10,000" */
export const formatRs = (n: number) => `Rs ${rs.format(n)}`;

/** Months of headline savings when paying yearly (yearly = monthly × 10). */
export const yearlySavings = (p: Plan) =>
  p.yearly != null && p.monthly != null ? p.monthly * 12 - p.yearly : 0;

/** Rounded % saved by paying yearly instead of monthly. */
export const yearlySavingsPct = (p: Plan) =>
  p.yearly != null && p.monthly != null
    ? Math.round((1 - p.yearly / (p.monthly * 12)) * 100)
    : 0;

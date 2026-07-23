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
    key: 'basic',
    name: 'Basic',
    tagline: 'Get selling',
    summary: 'A single cafe finding its feet.',
    yearly: 10000,
    monthly: 1000,
    cta: { label: 'Start free trial', action: 'trial' },
    features: [
      'Up to 3 staff logins',
      'Unlimited menu items, categories & tables',
      'Bulk menu import (AI)',
      'Orders, live floor & kitchen tickets',
      'Public QR menu',
      'Daily sales reports & shift close',
      'Cash drawer & expenses',
      '13% VAT + service charge · eSewa & Khalti',
    ],
  },
  {
    key: 'standard',
    name: 'Standard',
    tagline: 'Run the whole floor',
    summary: 'A busy cafe running full service.',
    yearly: 15000,
    monthly: 1500,
    featured: true,
    cta: { label: 'Start free trial', action: 'trial' },
    inherits: 'Everything in Basic, plus',
    features: [
      'Up to 8 staff logins',
      'Inventory & low-stock alerts',
      'Full transaction history',
      'Customer credit / house tabs',
      'Thermal printing (one outlet)',
      'Priority support',
    ],
  },
  {
    key: 'business',
    name: 'Business',
    tagline: 'See the money',
    summary: 'Owners who run the numbers, not just the till.',
    yearly: 25000,
    monthly: 2500,
    cta: { label: 'Start free trial', action: 'trial' },
    inherits: 'Everything in Standard, plus',
    features: [
      'Unlimited staff logins',
      'Owner finance — equity, loans, payouts',
      'Advanced analytics & profitability (P&L, heatmaps)',
      'Staff records, scheduling & custom roles',
      'Email shift summaries',
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

/* Feature catalog for the /features page. `plan` on each feature is the
 * LOWEST tier that unlocks it; higher tiers inherit everything below.
 * Mirrors the marketing ladder in `plans.ts` (and the backend 13-key
 * catalog in apps/api/internal/billing/features.go). Marketing copy —
 * enforcing this per-plan is a separate backend task. */

export type PlanKey = 'basic' | 'standard' | 'business' | 'enterprise';

export const PLAN_ORDER: PlanKey[] = ['basic', 'standard', 'business', 'enterprise'];
export const PLAN_LABEL: Record<PlanKey, string> = {
  basic: 'Basic',
  standard: 'Standard',
  business: 'Business',
  enterprise: 'Enterprise',
};

/** True when a plan includes a feature that starts on tier `starts`. */
export const planIncludes = (plan: PlanKey, starts: PlanKey) =>
  PLAN_ORDER.indexOf(plan) >= PLAN_ORDER.indexOf(starts);

export type Feature = { name: string; desc: string; plan: PlanKey };
export type FeatureGroup = { key: string; title: string; blurb: string; features: Feature[] };

export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    key: 'service',
    title: 'Service & orders',
    blurb: 'The core of every shift — from the first tap to the fired ticket.',
    features: [
      { name: 'Orders & live floor', desc: 'Take orders by table and watch the whole floor update in real time.', plan: 'basic' },
      { name: 'Kitchen & bar tickets', desc: 'Fire an order and it lands on the kitchen or bar screen instantly.', plan: 'basic' },
      { name: 'Table & tab management', desc: 'Open, name and track tabs across the room without losing a thing.', plan: 'basic' },
      { name: 'Split, merge & move', desc: 'Split a bill, merge two tables, or move a tab — in a tap, mid-service.', plan: 'basic' },
      { name: 'Public QR menu', desc: 'A branded menu customers scan and browse. Update it any time, no reprinting.', plan: 'basic' },
      { name: 'Offline mode & sync', desc: 'Keeps taking orders when the wifi drops, then syncs safely — no duplicates.', plan: 'basic' },
      { name: 'Runs on any device', desc: 'Installs as an app on the phones, tablets and laptops you already own.', plan: 'basic' },
      { name: 'Thermal & network printing', desc: 'Kitchen dockets and receipts to common 58/80mm thermal and Wi-Fi printers (single outlet).', plan: 'standard' },
    ],
  },
  {
    key: 'payments',
    title: 'Payments & tax',
    blurb: 'Take money every way Nepal pays — and keep it all reconciled.',
    features: [
      { name: 'eSewa & Khalti QR', desc: 'Accept the digital wallets your customers already use.', plan: 'basic' },
      { name: 'Cash, card & bank', desc: 'Every tender tracked and reconciled in one place.', plan: 'basic' },
      { name: '13% VAT & service charge', desc: 'Nepal tax and service charge applied to every bill, automatically.', plan: 'basic' },
      { name: 'Customer credit / house tabs', desc: 'Let regulars run a tab and settle later, with a clean ledger.', plan: 'standard' },
    ],
  },
  {
    key: 'inventory',
    title: 'Inventory & menu',
    blurb: 'Know what you have, what it costs, and when you’re about to run out.',
    features: [
      { name: 'Stock levels & movements', desc: 'Track what you hold and where it went.', plan: 'standard' },
      { name: 'Low-stock alerts', desc: 'Know before you run out, not after.', plan: 'standard' },
      { name: 'Recipe & pack rules', desc: 'Link items to ingredients so every sale draws down stock.', plan: 'standard' },
      { name: 'Bulk menu import', desc: 'Snap your printed menu and import it in minutes with AI.', plan: 'basic' },
    ],
  },
  {
    key: 'reports',
    title: 'Reports & analytics',
    blurb: 'From the daily close to the numbers that actually change your menu.',
    features: [
      { name: 'Daily sales & shift close', desc: 'End the day with a clean, reconciled summary.', plan: 'basic' },
      { name: 'Full transaction history', desc: 'Every order and payment, searchable, kept for good.', plan: 'standard' },
      { name: 'Advanced analytics', desc: 'Heatmaps, sales velocity, category and table mix, top sellers.', plan: 'business' },
      { name: 'Profitability / P&L', desc: 'Profit by category with drill-down — not just revenue.', plan: 'business' },
    ],
  },
  {
    key: 'finance-team',
    title: 'Finance & team',
    blurb: 'The owner’s side of the business, and the people who run it.',
    features: [
      { name: 'Cash drawer & expenses', desc: 'Track the drawer, petty cash and daily expenses.', plan: 'basic' },
      { name: 'Owner finance', desc: 'Equity, investments, loans, payouts and owner-cash custody.', plan: 'business' },
      { name: 'Email shift summaries', desc: 'A tidy recap in your inbox when a shift closes.', plan: 'business' },
      { name: 'Staff records', desc: 'Profiles, private documents and a salary pay ledger.', plan: 'business' },
      { name: 'Staff scheduling', desc: 'Rosters and a drag-to-edit shift timeline.', plan: 'business' },
      { name: 'Custom roles', desc: 'Build permission roles beyond the built-in ones.', plan: 'business' },
    ],
  },
  {
    key: 'scale',
    title: 'Scale & platform',
    blurb: 'For groups and franchises running more than one place.',
    features: [
      { name: 'Multiple outlets', desc: 'Several prep stations and locations, each with its own screens and printers.', plan: 'enterprise' },
      { name: 'Custom feature requests', desc: 'Need something specific? We build to fit how your group works.', plan: 'enterprise' },
      { name: 'Audit logs', desc: 'A tenant-wide activity timeline for compliance.', plan: 'enterprise' },
      { name: 'Custom domain & branding', desc: 'Your name and look across the whole experience.', plan: 'enterprise' },
      { name: 'API & webhooks', desc: 'Connect GoServe to the rest of your stack.', plan: 'enterprise' },
      { name: 'Dedicated onboarding & SLA', desc: 'Hands-on setup, training, and a support guarantee.', plan: 'enterprise' },
    ],
  },
];

/* Compact comparison matrix — only the tier-differentiating features
 * (everything here starts above Basic). Cumulative ✓ is computed with
 * planIncludes(). */
export const MATRIX_FEATURES: { name: string; plan: PlanKey }[] = [
  { name: 'Customer credit / house tabs', plan: 'standard' },
  { name: 'Inventory & low-stock alerts', plan: 'standard' },
  { name: 'Thermal & network printing', plan: 'standard' },
  { name: 'Full transaction history', plan: 'standard' },
  { name: 'Advanced analytics', plan: 'business' },
  { name: 'Profitability / P&L', plan: 'business' },
  { name: 'Owner finance', plan: 'business' },
  { name: 'Staff records & scheduling', plan: 'business' },
  { name: 'Custom roles', plan: 'business' },
  { name: 'Email shift summaries', plan: 'business' },
  { name: 'Multiple outlets', plan: 'enterprise' },
  { name: 'Custom feature requests', plan: 'enterprise' },
  { name: 'Audit logs', plan: 'enterprise' },
  { name: 'Custom domain & branding', plan: 'enterprise' },
  { name: 'API & webhooks', plan: 'enterprise' },
  { name: 'Dedicated onboarding & SLA', plan: 'enterprise' },
];

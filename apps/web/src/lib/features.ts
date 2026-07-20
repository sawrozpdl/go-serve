// Code-defined premium feature keys, mirrored from the backend
// internal/billing.Registry. Used by <FeatureGate>, <UpgradePrompt>, the owner
// Plan page, and the super-admin plan editor. Keep in sync with the backend
// registry (the /v1/super/features endpoint is the authoritative list for the
// plan editor; this map provides labels for owner-facing surfaces).
export const KNOWN_FEATURES: Record<string, { label: string; desc: string; group: string }> = {
  advanced_analytics: {
    label: 'Advanced Analytics',
    desc: 'Heatmaps, sales velocity, category/table mix, and top sellers on the dashboard.',
    group: 'Analytics & Reports',
  },
  profitability: {
    label: 'Profitability Report',
    desc: 'Profit & loss by category with per-category drilldown.',
    group: 'Analytics & Reports',
  },
  owner_finance: {
    label: 'Owner Finance',
    desc: 'Owners, equity, investments, loans, payouts and owner-cash custody.',
    group: 'Finance',
  },
  house_tabs: {
    label: 'Credit',
    desc: 'Customer credit accounts — running ledgers and their settlements.',
    group: 'Finance',
  },
  staff_hr: {
    label: 'Staff Records',
    desc: 'Staff profiles, private personal documents, and the salary pay ledger.',
    group: 'Team & Staff',
  },
  staff_scheduling: {
    label: 'Staff Scheduling',
    desc: 'Roster, shift timeline, and per-staff schedules.',
    group: 'Team & Staff',
  },
  custom_roles: {
    label: 'Custom Roles',
    desc: 'Create and edit custom permission roles beyond the built-in defaults.',
    group: 'Team & Staff',
  },
  email_shift_summaries: {
    label: 'Email Shift Summaries',
    desc: 'Email owners and managers a summary when a shift is closed.',
    group: 'Team & Staff',
  },
  multi_outlet: {
    label: 'Multiple Outlets',
    desc: 'Run more than one prep station (Kitchen, Bar, …) with per-outlet printers.',
    group: 'Operations',
  },
  inventory: {
    label: 'Inventory',
    desc: 'Stock levels, movements, adjustments, pack rules and low-stock alerts.',
    group: 'Operations',
  },
  menu_import: {
    label: 'Bulk Menu Import',
    desc: 'Import categories and items in one step from an AI-parsed menu.',
    group: 'Operations',
  },
  thermal_printing: {
    label: 'Thermal Printing',
    desc: 'Network/thermal printer setup for kitchen dockets and receipts.',
    group: 'Operations',
  },
  audit_logs: {
    label: 'Audit Logs',
    desc: 'Record and view the tenant activity timeline — who changed what, when. Off by default; enable per tenant.',
    group: 'Compliance',
  },
};

export function featureLabel(key: string): string {
  return KNOWN_FEATURES[key]?.label ?? key;
}

// Contact details for the "contact us to upgrade" CTAs. Configurable per
// deployment; sensible defaults for the Sahan team.
export const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL ?? 'hello@sahancafe.app';
export const CONTACT_PHONE = import.meta.env.VITE_CONTACT_PHONE ?? '';

export type SupportContact = { name: string; email: string; phone?: string };

// The support team shown in the "Contact us" modal. Saroj reuses the
// deployment-configured contact; the others are fixed team members.
export const SUPPORT_CONTACTS: SupportContact[] = [
  { name: 'Saroj', email: CONTACT_EMAIL, phone: CONTACT_PHONE || undefined },
  { name: 'Sudip', email: 'sudip.kunwar9898@gmail.com', phone: '9843413772' },
  { name: 'Asmin', email: 'shrestha.asmin17@gmail.com', phone: '9860099303' },
];

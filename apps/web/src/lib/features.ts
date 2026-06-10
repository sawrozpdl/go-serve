// Code-defined premium feature keys, mirrored from the backend
// internal/billing.Registry. Used by <FeatureGate>, <UpgradePrompt>, the owner
// Plan page, and the super-admin plan editor. Keep in sync with the backend
// registry (the /v1/super/features endpoint is the authoritative list for the
// plan editor; this map provides labels for owner-facing surfaces).
export const KNOWN_FEATURES: Record<string, { label: string; desc: string }> = {
  advanced_analytics: {
    label: 'Advanced Analytics',
    desc: 'Heatmaps, sales velocity, category/table mix, and top sellers on the dashboard.',
  },
  email_shift_summaries: {
    label: 'Email Shift Summaries',
    desc: 'Email owners and managers a summary when a shift is closed.',
  },
};

export function featureLabel(key: string): string {
  return KNOWN_FEATURES[key]?.label ?? key;
}

// Contact details for the "contact us to upgrade" CTAs. Configurable per
// deployment; sensible defaults for the Sahan team.
export const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL ?? 'hello@sahancafe.app';
export const CONTACT_PHONE = import.meta.env.VITE_CONTACT_PHONE ?? '';

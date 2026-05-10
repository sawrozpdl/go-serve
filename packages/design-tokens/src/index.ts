/**
 * Tenant branding override shape. Stored on `tenants.branding` jsonb.
 * Only colors + identity are tenant-controlled; structural tokens (spacing,
 * type, radii) are product brand and do not change per tenant in v1.
 */
export type MoodKey =
  | 'amber-dawn'
  | 'rose-bistro'
  | 'forest-cottage'
  | 'cobalt-modern'
  | 'crimson-trattoria'
  | 'mocha-warm'
  | 'midnight-jazz';

export type TenantBranding = {
  brandPrimary?: string; // hex, replaces --amber-500
  brandAccent?: string; // hex, replaces --lime-500
  cafeName?: string;
  logoUrl?: string;
  wordmarkUrl?: string;
  /** Mood preset selected in Settings → Personality. Drives the curated
   * color pair via `MOODS[mood]` when applied. The colors themselves still
   * live in `brandPrimary`/`brandAccent` — `mood` is a label so the UI can
   * show which preset is active. */
  mood?: MoodKey;
  /** Short, configurable line displayed under the cafe name on the
   * dashboard greeting. e.g. "fresh roast, every morning". */
  tagline?: string;
  /** A single emoji used as a decorative accent on the brand mark and
   * the dashboard greeting. e.g. ☕ 🥐 🍵 🥖 🍣. */
  accentEmoji?: string;
};

export type Mood = {
  key: MoodKey;
  name: string;
  primary: string;
  accent: string;
  emoji: string;
  blurb: string;
};

export const MOODS: Mood[] = [
  {
    key: 'amber-dawn',
    name: 'Amber Dawn',
    primary: '#FFA319',
    accent: '#A3F02C',
    emoji: '☕',
    blurb: 'warm morning roast — the house default',
  },
  {
    key: 'rose-bistro',
    name: 'Rosé Bistro',
    primary: '#FF4FA0',
    accent: '#FFE066',
    emoji: '🥐',
    blurb: 'soft pinks for an afternoon café',
  },
  {
    key: 'forest-cottage',
    name: 'Forest Cottage',
    primary: '#2BB07F',
    accent: '#FFD93D',
    emoji: '🌿',
    blurb: 'green & honey, leafy + grounded',
  },
  {
    key: 'cobalt-modern',
    name: 'Cobalt Modern',
    primary: '#3D7BFF',
    accent: '#A3F02C',
    emoji: '🍵',
    blurb: 'cool blues for a clean modern feel',
  },
  {
    key: 'crimson-trattoria',
    name: 'Crimson Trattoria',
    primary: '#E54B4B',
    accent: '#FFB534',
    emoji: '🍝',
    blurb: 'rosso italiano — bold and warm',
  },
  {
    key: 'mocha-warm',
    name: 'Mocha Warm',
    primary: '#C28860',
    accent: '#F2C9A0',
    emoji: '🍪',
    blurb: 'cocoa + cream, low-contrast and cozy',
  },
  {
    key: 'midnight-jazz',
    name: 'Midnight Jazz',
    primary: '#B98CFF',
    accent: '#FFD27A',
    emoji: '🎷',
    blurb: 'late-night purple for cocktail bars',
  },
];

const COLOR_VAR_MAP: Partial<Record<keyof TenantBranding, string>> = {
  brandPrimary: '--amber-500',
  brandAccent: '--lime-500',
};

/** Build a CSS string that overrides brand custom properties. */
export function brandingToCss(b: TenantBranding | null | undefined): string {
  if (!b) return '';
  const lines: string[] = [];
  for (const k of Object.keys(COLOR_VAR_MAP) as (keyof TenantBranding)[]) {
    const cssVar = COLOR_VAR_MAP[k];
    const value = b[k];
    if (cssVar && value && typeof value === 'string') lines.push(`  ${cssVar}: ${value};`);
  }
  if (lines.length === 0) return '';
  return `:root {\n${lines.join('\n')}\n}\n`;
}

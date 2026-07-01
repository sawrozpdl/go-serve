/**
 * buildTheme — pure function that resolves a flat, ready-to-consume Theme from
 * a tenant's branding and the active color scheme.
 *
 * This is deliberately dependency-free (no React, no storage, no RN) so it can
 * be exhaustively unit-tested across all 12 moods × 2 schemes × 3 typography
 * presets. The ThemeProvider is the only stateful wrapper around it.
 */
import {
  BASE_RADII,
  BASE_SPACING,
  BRAND,
  FIELD_RHYTHM,
  MOODS,
  MOTION,
  TEXT_SCALE,
  TYPOGRAPHIES,
  inkScaleFor,
  statusColorsFor,
  type ColorScheme,
  type InkScale,
  type MoodKey,
  type StatusColors,
  type TenantBranding,
  type TypographyKey,
} from '@cafe-mgmt/design-tokens';
import { FONT_FAMILY, type FontFamilies } from './fonts';

export type ThemeColors = {
  /** Full ink scale for the active scheme (50 = highest contrast text). */
  ink: InkScale;
  /** Page background (lowest ink). */
  bg: string;
  /** Panel surface. */
  surface: string;
  /** Card surface (elevated). */
  card: string;
  /** Hairline / divider. */
  border: string;
  /** Primary body text. */
  text: string;
  /** Secondary text. */
  textMuted: string;
  /** Tertiary / hint text. */
  textFaint: string;
  /** Brand primary fill (amber by default, tenant-overridable). */
  primary: string;
  /** Brand accent fill (lime by default, tenant-overridable). */
  accent: string;
  /** Low-alpha brand wash — tint for selected/occupied surfaces. */
  primaryWash: string;
  /** Slightly-lifted card fill (a touch brighter than `card`). */
  cardElevated: string;
  /** 1px top-edge highlight on lifted cards (transparent in light mode). */
  bevel: string;
  /** Ink to place ON TOP of a vivid brand fill — pinned dark both schemes. */
  onBrand: string;
} & StatusColors;

/** Cross-platform shadow style (kept RN-free so buildTheme stays pure). */
export type ShadowStyle = {
  shadowColor: string;
  shadowOpacity: number;
  shadowRadius: number;
  shadowOffset: { width: number; height: number };
  elevation: number;
};

export type ThemeTypography = {
  key: TypographyKey;
  /** Font family for display headings (italic/weight baked into the family). */
  displayFamily: string;
  /** Body / UI font family. */
  bodyFamily: string;
  /** Tabular-figure numeric font family. */
  numFamily: string;
  /** Heading text-transform for this preset. */
  headingTransform: 'none' | 'uppercase';
  /** Extra letter-spacing applied to headings (px). */
  headingTracking: number;
};

export type Theme = {
  scheme: ColorScheme;
  colors: ThemeColors;
  spacing: typeof BASE_SPACING;
  radii: typeof BASE_RADII;
  text: typeof TEXT_SCALE;
  fieldRhythm: typeof FIELD_RHYTHM;
  motion: typeof MOTION;
  typography: ThemeTypography;
  /** All loaded font families, for components that pick a weight directly. */
  fonts: FontFamilies;
  /** Shadow presets for lifted surfaces. */
  elevation: { card: ShadowStyle; raised: ShadowStyle };
  /** The mood key in effect (informational; label for the picker). */
  mood: MoodKey | null;
};

/** Convert a #RGB / #RRGGBB hex to an rgba() string at `alpha`. Returns the
 * input unchanged if it isn't a parseable hex (defensive for odd brand values). */
export function hexToRgba(hex: string, alpha: number): string {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return hex;
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const DEFAULT_TYPOGRAPHY: TypographyKey = 'editorial';

function resolveTypography(key: TypographyKey): ThemeTypography {
  switch (key) {
    case 'modern':
      return {
        key,
        displayFamily: FONT_FAMILY.bodyBold, // uppercase tracked sans
        bodyFamily: FONT_FAMILY.body,
        numFamily: FONT_FAMILY.body,
        headingTransform: 'uppercase',
        headingTracking: 1,
      };
    case 'minimal':
      return {
        key,
        displayFamily: FONT_FAMILY.bodySemi, // clean sentence-case sans
        bodyFamily: FONT_FAMILY.body,
        numFamily: FONT_FAMILY.body,
        headingTransform: 'none',
        headingTracking: 0,
      };
    case 'editorial':
    default:
      return {
        key: 'editorial',
        displayFamily: FONT_FAMILY.displayItalic, // italic serif house voice
        bodyFamily: FONT_FAMILY.body,
        numFamily: FONT_FAMILY.body,
        headingTransform: 'none',
        headingTracking: 0,
      };
  }
}

/** Resolve the brand primary/accent, honoring an explicit hex first, then the
 * selected mood's curated pair, then the house default. */
function resolveBrand(branding: TenantBranding | null | undefined): {
  primary: string;
  accent: string;
  mood: MoodKey | null;
} {
  const moodKey = branding?.mood ?? null;
  const mood = moodKey ? (MOODS.find((m) => m.key === moodKey) ?? null) : null;
  const primary = branding?.brandPrimary ?? mood?.primary ?? BRAND.amber500;
  const accent = branding?.brandAccent ?? mood?.accent ?? BRAND.lime500;
  return { primary, accent, mood: mood?.key ?? null };
}

export function buildTheme(
  branding: TenantBranding | null | undefined,
  scheme: ColorScheme,
): Theme {
  const ink = inkScaleFor(scheme);
  const status = statusColorsFor(scheme);
  const { primary, accent, mood } = resolveBrand(branding);
  const typographyKey = branding?.typography ?? DEFAULT_TYPOGRAPHY;
  const dark = scheme === 'dark';

  return {
    scheme,
    colors: {
      ink,
      bg: ink[1000],
      surface: ink[900],
      card: ink[800],
      cardElevated: dark ? ink[700] : ink[900],
      border: ink[700],
      bevel: dark ? 'rgba(255,255,255,0.06)' : 'transparent',
      text: ink[100],
      textMuted: ink[200],
      textFaint: ink[300],
      primary,
      accent,
      primaryWash: hexToRgba(primary, dark ? 0.16 : 0.12),
      onBrand: BRAND.onBrand,
      ...status,
    },
    elevation: {
      card: {
        shadowColor: '#000',
        shadowOpacity: dark ? 0.3 : 0.1,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 },
        elevation: 4,
      },
      raised: {
        shadowColor: '#000',
        shadowOpacity: dark ? 0.45 : 0.16,
        shadowRadius: 24,
        shadowOffset: { width: 0, height: 12 },
        elevation: 10,
      },
    },
    spacing: BASE_SPACING,
    radii: BASE_RADII,
    text: TEXT_SCALE,
    fieldRhythm: FIELD_RHYTHM,
    motion: MOTION,
    typography: resolveTypography(typographyKey),
    fonts: FONT_FAMILY,
    mood,
  };
}

/** All typography keys, exported for exhaustive testing / picker UIs. */
export const TYPOGRAPHY_KEYS: TypographyKey[] = TYPOGRAPHIES.map((t) => t.key);

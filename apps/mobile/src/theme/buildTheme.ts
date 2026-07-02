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
  FOCUS,
  MOODS_V2,
  MOTION,
  TEXT_SCALE_V2,
  TOUCH,
  TYPE_STYLES,
  TYPOGRAPHIES,
  inkScaleV2For,
  stampToneFgFor,
  statusColorsV2For,
  type ColorScheme,
  type InkScale,
  type MoodKey,
  type StampTone,
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
  /** Low-alpha brand wash — tint for selected/occupied surfaces that do NOT
   * cast a shadow (chips, non-elevated fills). */
  primaryWash: string;
  /** OPAQUE brand tint — the selected/occupied fill for ELEVATED cards/tiles.
   * A translucent bg under an Android `elevation` shadow renders a hard
   * rectangle artifact, so elevated surfaces must use this opaque blend. */
  primaryTint: string;
  /** Slightly-lifted card fill (a touch brighter than `card`). */
  cardElevated: string;
  /** 1px top-edge highlight on lifted cards (transparent in light mode). */
  bevel: string;
  /** Ink to place ON TOP of a vivid brand fill — pinned dark both schemes. */
  onBrand: string;
  /** Surface levels 0–3 (page → panel → card → overlay/sheet). Prefer these
   * over picking ink steps directly in new components. */
  surfaces: Record<0 | 1 | 2 | 3, string>;
  /** Stamp (status-chip) tone triples. Backgrounds/borders are OPAQUE mixes
   * over the card surface (Android elevation artifact — see primaryTint). */
  stamp: Record<StampTone, StampToneColors>;
} & StatusColors;

export type StampToneColors = { fg: string; bg: string; border: string };

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
  text: typeof TEXT_SCALE_V2;
  /** Paired size/lineHeight/tracking per ramp step — use for any Text that
   * isn't covered by an AppText/Heading variant. */
  typeStyles: typeof TYPE_STYLES;
  fieldRhythm: typeof FIELD_RHYTHM;
  motion: typeof MOTION;
  typography: ThemeTypography;
  /** All loaded font families, for components that pick a weight directly. */
  fonts: FontFamilies;
  /** Shadow presets for lifted surfaces. */
  elevation: { card: ShadowStyle; raised: ShadowStyle };
  /** Focus/selected ring (hardware keyboards on tablets, selected tiles). */
  focus: { ringColor: string; ringWidth: number; ringOffset: number };
  /** Skeleton shimmer fills — opaque (Android elevation artifact). */
  skeleton: { base: string; highlight: string };
  /** Minimum touch-target sizes (dp). */
  touch: typeof TOUCH;
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

/** Parse a #RGB / #RRGGBB hex to a 24-bit int, or null if unparseable. */
function parseHex(hex: string): number | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || /[^0-9a-fA-F]/.test(h)) return null;
  return parseInt(h, 16);
}

/** Blend `fg` over `bg` at ratio `t` (0..1), returning an OPAQUE #RRGGBB.
 * Unlike hexToRgba (which stays translucent), this bakes the tint into a solid
 * color — needed for elevated surfaces where a translucent bg would trigger
 * Android's rectangular-shadow artifact. Returns `fg` if either isn't hex. */
export function mixHex(fg: string, bg: string, t: number): string {
  const a = parseHex(fg);
  const b = parseHex(bg);
  if (a == null || b == null) return fg;
  const chan = (shift: number) => {
    const av = (a >> shift) & 255;
    const bv = (b >> shift) & 255;
    return Math.round(bv + (av - bv) * t);
  };
  const rgb = (chan(16) << 16) | (chan(8) << 8) | chan(0);
  return `#${(rgb | (1 << 24)).toString(16).slice(1)}`;
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
  const mood = moodKey ? (MOODS_V2.find((m) => m.key === moodKey) ?? null) : null;
  const primary = branding?.brandPrimary ?? mood?.primary ?? BRAND.amber500;
  const accent = branding?.brandAccent ?? mood?.accent ?? BRAND.lime500;
  return { primary, accent, mood: mood?.key ?? null };
}

/** Derive the opaque {fg,bg,border} triple for one stamp tone over `card`. */
function stampTriple(fg: string, card: string, dark: boolean): StampToneColors {
  return {
    fg,
    bg: mixHex(fg, card, dark ? 0.18 : 0.12),
    border: mixHex(fg, card, dark ? 0.45 : 0.35),
  };
}

export function buildTheme(
  branding: TenantBranding | null | undefined,
  scheme: ColorScheme,
): Theme {
  const ink = inkScaleV2For(scheme);
  const status = statusColorsV2For(scheme);
  const { primary, accent, mood } = resolveBrand(branding);
  const typographyKey = branding?.typography ?? DEFAULT_TYPOGRAPHY;
  const dark = scheme === 'dark';

  const card = ink[800];
  const cardElevated = dark ? ink[700] : ink[900];
  const stampFg = stampToneFgFor(scheme);
  /** Brand-stamp text: the raw primary works on dark; on light it is darkened
   * toward ink for contrast on paper (amber #FFA319 → ~amber-700 range). */
  const brandStampFg = dark ? primary : mixHex(primary, '#000000', 0.72);

  return {
    scheme,
    colors: {
      ink,
      bg: ink[1000],
      surface: ink[900],
      card,
      cardElevated,
      border: ink[700],
      bevel: dark ? 'rgba(255,255,255,0.06)' : 'transparent',
      text: ink[100],
      textMuted: ink[200],
      textFaint: ink[300],
      primary,
      accent,
      primaryWash: hexToRgba(primary, dark ? 0.16 : 0.12),
      primaryTint: mixHex(primary, ink[800], dark ? 0.16 : 0.12),
      onBrand: BRAND.onBrand,
      surfaces: { 0: ink[1000], 1: ink[900], 2: card, 3: cardElevated },
      stamp: {
        neutral: stampTriple(stampFg.neutral, card, dark),
        info: stampTriple(stampFg.info, card, dark),
        warn: stampTriple(stampFg.warn, card, dark),
        success: stampTriple(stampFg.success, card, dark),
        danger: stampTriple(stampFg.danger, card, dark),
        brand: stampTriple(brandStampFg, card, dark),
      },
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
    text: TEXT_SCALE_V2,
    typeStyles: TYPE_STYLES,
    fieldRhythm: FIELD_RHYTHM,
    motion: MOTION,
    typography: resolveTypography(typographyKey),
    fonts: FONT_FAMILY,
    focus: { ringColor: primary, ringWidth: FOCUS.ringWidth, ringOffset: FOCUS.ringOffset },
    skeleton: dark
      ? { base: ink[800], highlight: ink[700] }
      : { base: ink[850], highlight: ink[900] },
    touch: TOUCH,
    mood,
  };
}

/** All typography keys, exported for exhaustive testing / picker UIs. */
export const TYPOGRAPHY_KEYS: TypographyKey[] = TYPOGRAPHIES.map((t) => t.key);

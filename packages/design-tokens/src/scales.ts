/**
 * Base design scales as plain JS/TS objects.
 *
 * The web app consumes tokens via `tokens.css` (CSS custom properties). Native
 * (React Native) has no CSS, so this module mirrors the SAME values as
 * `tokens.css` in a form JS can read directly. Keep the two in sync: if you edit
 * a value here, edit it in `tokens.css` too (and vice-versa). `tokens.css`
 * remains the human-facing source of truth for the web; these exports are the
 * machine-facing mirror for anything that can't parse CSS.
 *
 * The ink scale is mode-aware: low numbers (50) are the highest-contrast text,
 * high numbers (1000) are the lowest-contrast surface. Same key → same role in
 * both modes; only the resolved hex changes.
 */

/** Ink scale — DARK mode (the bare `:root` values in tokens.css). */
export const INK_SCALE_DARK = {
  1000: '#07060a', // page bg, lowest
  900: '#100d14', // panels
  850: '#15121a',
  800: '#1c1822', // cards
  700: '#25212c', // sunken / divider tone
  600: '#312c39', // hover surfaces
  500: '#423c4a', // heavy borders
  400: '#5d566a', // muted icons
  300: '#8e8799', // tertiary text
  200: '#c0b8c8', // secondary text
  100: '#ece6f1', // primary text
  50: '#f7f2fa', // hi-contrast / display
} as const;

/** Ink scale — LIGHT mode (`[data-theme='light']` in tokens.css). */
export const INK_SCALE_LIGHT = {
  1000: '#fdfaf3', // page bg, off-white warm
  900: '#f6f1e6', // panels
  850: '#ede7d7',
  800: '#e2dac7', // cards
  700: '#cdc4ad', // dividers / sunken tone
  600: '#b3a98e', // hover surfaces
  500: '#8c8265', // heavy borders
  400: '#655c44', // muted icons
  300: '#4a4232', // tertiary text
  200: '#2e2a20', // secondary text
  100: '#18160f', // primary text
  50: '#080704', // hi-contrast / display
} as const;

export type InkKey = keyof typeof INK_SCALE_DARK;
/** Ink scale shape — keys fixed, values widened to string so both the light
 * and dark constant maps are assignable to it. */
export type InkScale = Record<InkKey, string>;

/** Spacing scale (px). Geometric ×1.5 past space-3. */
export const BASE_SPACING = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  7: 32,
  8: 40,
  9: 56,
  10: 72,
} as const;

export type SpacingKey = keyof typeof BASE_SPACING;

/** Form-field rhythm (px). */
export const FIELD_RHYTHM = {
  fieldGap: 22,
  fieldLabelGap: 10,
  sectionGap: 36,
} as const;

/** Corner radii (px). `pill` is fully-rounded. */
export const BASE_RADII = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 28,
  pill: 9999,
} as const;

export type RadiusKey = keyof typeof BASE_RADII;

/** Motion durations (ms) + easing cubic-bezier control points.
 * Reanimated/Easing consumers can spread the tuple into `Easing.bezier(...)`. */
export const MOTION = {
  durFast: 120,
  durBase: 180,
  durSlow: 280,
  easeOut: [0.2, 0.8, 0.2, 1] as const,
  easeSpring: [0.16, 1, 0.3, 1] as const,
  easeIn: [0.4, 0, 0.6, 1] as const,
} as const;

/** Type scale (px) — the small-text sizes the app uses. */
export const TEXT_SCALE = {
  '2xs': 10, // pills, mono eyebrows
  xs: 11, // meta, hints
  sm: 12, // secondary copy
  md: 13, // compact body
  lg: 15, // emphasized body
} as const;

export type TextKey = keyof typeof TEXT_SCALE;

/** Brand palette — constant across light/dark (same hue in both modes). */
export const BRAND = {
  amber50: '#fff4d9',
  amber100: '#ffe2a0',
  amber300: '#ffc25a',
  amber500: '#ffa319', // primary
  amber600: '#e68a00',
  amber700: '#b86f00',
  amberGlow: '255, 163, 25', // rgb tuple for glow effects
  lime50: '#ecffd2',
  lime300: '#c8ff6e',
  lime500: '#a3f02c', // accent
  lime700: '#5e8e10',
  limeGlow: '163, 240, 44',
  /** Ink on top of a vivid brand fill — pinned dark in BOTH themes. */
  onBrand: '#08070a',
} as const;

/** Semantic status foreground/background colors, per mode. Values mirror the
 * status tokens in tokens.css (`--danger-fg`, `--success-fg`, etc.). */
export const STATUS_DARK = {
  amberFg: BRAND.amber500,
  limeFg: BRAND.lime500,
  dangerFg: '#ff8a80',
  dangerBg: 'rgba(255, 138, 128, 0.10)',
  dangerBorder: 'rgba(255, 138, 128, 0.30)',
  infoFg: '#b8d2ff',
  infoFgStrong: '#6db7ff',
  infoBg: 'rgba(120, 180, 255, 0.08)',
  infoBorder: 'rgba(120, 180, 255, 0.25)',
  successFg: '#6cd58a',
  warnFgTile: '#f0b85a',
  okBg: 'rgba(163, 240, 44, 0.10)',
  okBorder: 'rgba(163, 240, 44, 0.30)',
  warnBg: 'rgba(255, 163, 25, 0.10)',
  warnBorder: 'rgba(255, 163, 25, 0.30)',
} as const;

export const STATUS_LIGHT = {
  amberFg: '#8a4d00',
  limeFg: '#3f6310',
  dangerFg: '#b8281f',
  dangerBg: 'rgba(184, 40, 31, 0.08)',
  dangerBorder: 'rgba(184, 40, 31, 0.30)',
  infoFg: '#1d4ed8',
  infoFgStrong: '#1e40af',
  infoBg: 'rgba(35, 98, 196, 0.08)',
  infoBorder: 'rgba(35, 98, 196, 0.25)',
  successFg: '#1f7a3c',
  warnFgTile: '#8a5500',
  okBg: 'rgba(94, 142, 16, 0.12)',
  okBorder: 'rgba(94, 142, 16, 0.35)',
  warnBg: 'rgba(184, 111, 0, 0.12)',
  warnBorder: 'rgba(184, 111, 0, 0.35)',
} as const;

/** Status color shape — keys fixed, values widened to string so both the light
 * and dark constant maps are assignable to it. */
export type StatusColors = Record<keyof typeof STATUS_DARK, string>;

/** Drop shadows, per mode (softer alpha on light). RN maps these via a helper;
 * kept here as the canonical offset/blur/alpha the web CSS uses. */
export const SHADOW_DARK = {
  md: '0 2px 8px rgba(0, 0, 0, 0.35)',
  lg: '0 10px 30px rgba(0, 0, 0, 0.4)',
} as const;

export const SHADOW_LIGHT = {
  md: '0 2px 8px rgba(28, 24, 16, 0.10)',
  lg: '0 10px 30px rgba(28, 24, 16, 0.12)',
} as const;

/** Font family stacks. RN uses only the first (loaded) family name; the rest
 * are web fallbacks and ignored natively. */
export const FONTS = {
  display: 'Fraunces',
  sans: 'Inter',
  mono: 'JetBrains Mono',
  num: 'Inter',
} as const;

export type ColorScheme = 'light' | 'dark';

/** Convenience: resolve the ink scale for a given mode. */
export function inkScaleFor(scheme: ColorScheme): InkScale {
  return scheme === 'light' ? INK_SCALE_LIGHT : INK_SCALE_DARK;
}

/** Convenience: resolve status colors for a given mode. */
export function statusColorsFor(scheme: ColorScheme): StatusColors {
  return scheme === 'light' ? STATUS_LIGHT : STATUS_DARK;
}

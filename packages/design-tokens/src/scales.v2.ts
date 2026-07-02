/**
 * v2 token layer — the "Docket" direction seam.
 *
 * The mobile redesign consumes these instead of (or on top of) the base scales
 * in `scales.ts`. This file is intentionally the ONLY place the chosen visual
 * direction's values live: swapping/tuning the direction means editing here,
 * nothing else. Web keeps consuming the v1 names in `scales.ts`/`tokens.css`
 * untouched until an explicit backport task folds v2 values into the roots.
 *
 * Phase 0 note: the ink/status V2 maps intentionally ALIAS the v1 values so
 * plumbing lands with zero visual change; the Docket palette drops in here at
 * the vertical-slice phase. The additive groups (extended type ramp, stamp
 * tones, focus/touch) are new keys with their final shape.
 *
 * Sync rule: static v2 values that web will eventually need are mirrored in
 * the "v2 (Docket)" block at the bottom of `tokens.css` — keep the two in sync.
 */
import {
  TEXT_SCALE,
  type ColorScheme,
  type InkScale,
  type StatusColors,
} from './scales';

/* ── Ink + status — the "Docket" palette ────────────────────────────────── */

/** Carbon — warm near-black (replaces the cool purple-black v1 dark). */
export const INK_SCALE_DARK_V2: InkScale = {
  1000: '#0f0e0b', // page bg — the carbon board
  900: '#171511', // panels
  850: '#1a1813',
  800: '#1d1b16', // cards
  700: '#2a2721', // hairline / divider
  600: '#37332a', // hover surfaces
  500: '#4a4438', // heavy borders
  400: '#6b6455', // muted icons
  300: '#8c857a', // tertiary text
  200: '#c4beb2', // secondary text
  100: '#f2eee6', // primary text
  50: '#fbf8f1', // hi-contrast / display
};

/** Paper — warm daylight. NOTE the deliberate monotonicity break: 800 (card)
 * is LIGHTER than 1000 (page) — a white docket popping on tinted paper. This
 * is intentional and safe: buildTheme maps roles (card/bg/border), and
 * primaryTint/stamp bgs mix against ink[800] so they come out warm cream. */
export const INK_SCALE_LIGHT_V2: InkScale = {
  1000: '#f6f3eb', // page bg — steamed-milk paper
  900: '#efebe0', // panels
  850: '#e8e3d4',
  800: '#fffdf8', // cards — white paper, lighter than page ON PURPOSE
  700: '#e3ddcf', // hairline / divider
  600: '#d6cfbc', // hover surfaces
  500: '#b3aa92', // heavy borders
  400: '#857d6b', // muted icons
  300: '#6e675c', // tertiary text
  200: '#3e382e', // secondary text
  100: '#16130e', // primary text — warm espresso ink
  50: '#0a0805',
};

export function inkScaleV2For(scheme: ColorScheme): InkScale {
  return scheme === 'light' ? INK_SCALE_LIGHT_V2 : INK_SCALE_DARK_V2;
}

/** Status — re-tuned warm. Same keys as STATUS_DARK/LIGHT. */
export const STATUS_DARK_V2: StatusColors = {
  amberFg: '#ffa319',
  limeFg: '#a3f02c',
  dangerFg: '#ff6b5e',
  dangerBg: 'rgba(255, 107, 94, 0.10)',
  dangerBorder: 'rgba(255, 107, 94, 0.30)',
  infoFg: '#b8d2ff',
  infoFgStrong: '#8fb6e8',
  infoBg: 'rgba(143, 182, 232, 0.08)',
  infoBorder: 'rgba(143, 182, 232, 0.25)',
  successFg: '#67c15e',
  warnFgTile: '#f0b85a',
  okBg: 'rgba(103, 193, 94, 0.10)',
  okBorder: 'rgba(103, 193, 94, 0.30)',
  warnBg: 'rgba(255, 163, 25, 0.10)',
  warnBorder: 'rgba(255, 163, 25, 0.30)',
};

export const STATUS_LIGHT_V2: StatusColors = {
  amberFg: '#b86f00',
  limeFg: '#3f6310',
  dangerFg: '#c23b2e',
  dangerBg: 'rgba(194, 59, 46, 0.08)',
  dangerBorder: 'rgba(194, 59, 46, 0.30)',
  infoFg: '#3b5f8a',
  infoFgStrong: '#2e4e77',
  infoBg: 'rgba(59, 95, 138, 0.08)',
  infoBorder: 'rgba(59, 95, 138, 0.25)',
  successFg: '#3e7a34',
  warnFgTile: '#8a5500',
  okBg: 'rgba(62, 122, 52, 0.10)',
  okBorder: 'rgba(62, 122, 52, 0.35)',
  warnBg: 'rgba(184, 111, 0, 0.12)',
  warnBorder: 'rgba(184, 111, 0, 0.35)',
};

export function statusColorsV2For(scheme: ColorScheme): StatusColors {
  return scheme === 'light' ? STATUS_LIGHT_V2 : STATUS_DARK_V2;
}

/* ── Type ramp v2 — extends the v1 scale upward ─────────────────────────── */

/** Full type scale (px). The Docket drop re-tunes md/lg to 14/16 (v1 was
 * 13/15) for more comfortable body/list copy; the new keys replace the
 * per-screen hardcoded display sizes (18/20/22/26/28/30/52 today). */
export const TEXT_SCALE_V2 = {
  ...TEXT_SCALE,
  md: 14, // body / working UI copy
  lg: 16, // emphasized body / row titles
  xl: 17, // emphasized body / list titles
  '2xl': 20, // card titles, KDS item names
  '3xl': 24, // sheet titles
  '4xl': 28, // screen titles
  display: 34, // KPI hero, order total
  displayLg: 44, // wordmark tier
} as const;

export type TextKeyV2 = keyof typeof TEXT_SCALE_V2;

export type TypeStyle = {
  size: number;
  lineHeight: number;
  /** Letter-spacing in px (RN convention). Negative on display tiers. */
  tracking: number;
};

/** Paired size/line-height/tracking per ramp step so screens stop guessing
 * line heights. Consumed as `theme.typeStyles.lg` etc. */
export const TYPE_STYLES: Record<TextKeyV2, TypeStyle> = {
  '2xs': { size: TEXT_SCALE_V2['2xs'], lineHeight: 14, tracking: 0.4 },
  xs: { size: TEXT_SCALE_V2.xs, lineHeight: 15, tracking: 0.2 },
  sm: { size: TEXT_SCALE_V2.sm, lineHeight: 17, tracking: 0 },
  md: { size: TEXT_SCALE_V2.md, lineHeight: 20, tracking: 0 },
  lg: { size: TEXT_SCALE_V2.lg, lineHeight: 22, tracking: 0 },
  xl: { size: TEXT_SCALE_V2.xl, lineHeight: 23, tracking: -0.1 },
  '2xl': { size: TEXT_SCALE_V2['2xl'], lineHeight: 26, tracking: -0.2 },
  '3xl': { size: TEXT_SCALE_V2['3xl'], lineHeight: 30, tracking: -0.3 },
  '4xl': { size: TEXT_SCALE_V2['4xl'], lineHeight: 33, tracking: -0.4 },
  display: { size: TEXT_SCALE_V2.display, lineHeight: 39, tracking: -0.5 },
  displayLg: { size: TEXT_SCALE_V2.displayLg, lineHeight: 49, tracking: -0.8 },
};

/* ── Stamp tones — status chips as "rubber stamps" ──────────────────────── */

/** Status-chip tones. `brand` is derived from the tenant primary at theme
 * build time; the rest have fixed per-scheme foregrounds here. Backgrounds and
 * borders are ALWAYS derived as OPAQUE mixes over the card surface in
 * buildTheme (translucent fills under Android `elevation` render a hard
 * rectangle artifact). */
export type StampTone = 'neutral' | 'info' | 'warn' | 'success' | 'danger' | 'brand';

export const STAMP_TONE_FG_DARK: Record<Exclude<StampTone, 'brand'>, string> = {
  neutral: INK_SCALE_DARK_V2[300],
  info: STATUS_DARK_V2.infoFgStrong,
  warn: STATUS_DARK_V2.warnFgTile,
  success: STATUS_DARK_V2.successFg,
  danger: STATUS_DARK_V2.dangerFg,
};

export const STAMP_TONE_FG_LIGHT: Record<Exclude<StampTone, 'brand'>, string> = {
  neutral: INK_SCALE_LIGHT_V2[300],
  info: STATUS_LIGHT_V2.infoFg,
  warn: STATUS_LIGHT_V2.warnFgTile,
  success: STATUS_LIGHT_V2.successFg,
  danger: STATUS_LIGHT_V2.dangerFg,
};

export function stampToneFgFor(scheme: ColorScheme): Record<Exclude<StampTone, 'brand'>, string> {
  return scheme === 'light' ? STAMP_TONE_FG_LIGHT : STAMP_TONE_FG_DARK;
}

/* ── Interaction constants ──────────────────────────────────────────────── */

/** Focus/selected ring geometry (color comes from the resolved brand primary). */
export const FOCUS = {
  ringWidth: 2,
  ringOffset: 2,
} as const;

/** Minimum touch-target sizes (dp). Every pressable in the component library
 * must reach at least `min` (44), incl. hitSlop. */
export const TOUCH = {
  min: 44,
  comfortable: 48,
} as const;

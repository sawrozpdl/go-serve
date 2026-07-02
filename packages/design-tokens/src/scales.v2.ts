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
  INK_SCALE_DARK,
  INK_SCALE_LIGHT,
  STATUS_DARK,
  STATUS_LIGHT,
  TEXT_SCALE,
  type ColorScheme,
  type InkScale,
  type StatusColors,
} from './scales';

/* ── Ink + status (Phase 0: alias v1; Docket values land here) ──────────── */

export const INK_SCALE_DARK_V2: InkScale = INK_SCALE_DARK;
export const INK_SCALE_LIGHT_V2: InkScale = INK_SCALE_LIGHT;

export function inkScaleV2For(scheme: ColorScheme): InkScale {
  return scheme === 'light' ? INK_SCALE_LIGHT_V2 : INK_SCALE_DARK_V2;
}

export const STATUS_DARK_V2: StatusColors = STATUS_DARK;
export const STATUS_LIGHT_V2: StatusColors = STATUS_LIGHT;

export function statusColorsV2For(scheme: ColorScheme): StatusColors {
  return scheme === 'light' ? STATUS_LIGHT_V2 : STATUS_DARK_V2;
}

/* ── Type ramp v2 — extends the v1 scale upward ─────────────────────────── */

/** Full type scale (px). The five v1 keys keep their v1 values until the
 * direction drop (md/lg re-tune to 14/16 then); the new keys replace the
 * per-screen hardcoded display sizes (18/20/22/26/28/30/52 today). */
export const TEXT_SCALE_V2 = {
  ...TEXT_SCALE,
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
  md: { size: TEXT_SCALE_V2.md, lineHeight: 19, tracking: 0 },
  lg: { size: TEXT_SCALE_V2.lg, lineHeight: 21, tracking: 0 },
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

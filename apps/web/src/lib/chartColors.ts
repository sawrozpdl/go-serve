/* The categorical chart palette — one canonical list.
 *
 * Two lists had drifted: the category-mix fallback used #6FB9FF/#FF7AA3 while
 * the category colour picker offered #7DD3FC/#F472B6. That meant a tenant could
 * pick a colour that sat a shade off whatever the chart would have chosen, and
 * two neighbouring slices could land on near-identical hues.
 *
 * Both now read from here, so every colour a category can have is a palette slot.
 * Starts on the brand pair (amber, lime) and then walks the hue circle, so the
 * first few slices — which are the big ones — look deliberate rather than random.
 */
export const CHART_PALETTE = [
  '#FFA319', // amber (brand primary)
  '#A3F02C', // lime (brand accent)
  '#7DD3FC', // sky
  '#F472B6', // pink
  '#C084FC', // violet
  '#34D399', // emerald
  '#FB7185', // rose
  '#94A3B8', // slate
] as const;

/** Colour for slice `idx`: the category's own colour when it has one, else the
 *  next palette slot. */
export function pickSliceColor(idx: number, raw?: string | null): string {
  if (raw) return raw;
  // The modulo can't go out of range, but noUncheckedIndexedAccess doesn't know
  // that; the ?? keeps the return type honest without an assertion.
  return CHART_PALETTE[idx % CHART_PALETTE.length] ?? CHART_PALETTE[0];
}

/** Fill for the rolled-up "Other" slice. Deliberately not a palette hue — it is
 *  a bucket, not a category, and should read as neutral. */
export const OTHER_COLOR = '#6B7280';

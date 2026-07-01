/**
 * Loaded font family names (the keys `useFonts` registers). Plain strings so the
 * pure `buildTheme` can reference them without importing font assets. Italic and
 * weight are baked into the family (React Native doesn't reliably synthesize
 * bold/italic for custom fonts), so pick the exact family you want.
 */
export const FONT_FAMILY = {
  /** Fraunces bold — headline display. */
  display: 'Fraunces_700Bold',
  /** Fraunces italic semibold — the editorial house voice (wordmark, headings). */
  displayItalic: 'Fraunces_600SemiBold_Italic',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemi: 'Inter_600SemiBold',
  bodyBold: 'Inter_700Bold',
} as const;

export type FontFamilies = typeof FONT_FAMILY;

// Chars-per-line at Font A: 58mm ≈ 32, 80mm ≈ 48.
export const COLS: Record<'58' | '80', number> = { '58': 32, '80': 48 };

// Common typographic characters mapped to ASCII fallbacks so KOTs stay
// printable on plain ASCII / CP437 printers.
const FALLBACKS: Record<string, string> = {
  '×': 'x', // × multiplication sign
  '»': '>', // »
  '·': '-', // · middle dot
  '’': "'", // ’ right single quote
  '“': '"', // “
  '”': '"', // ”
  '–': '-', // – en dash
  '—': '-', // — em dash
  '₹': 'Rs', // ₹ rupee sign
  'रू': 'Rs', // रू
};

/**
 * Encode a string to CP437-ish single-byte output. ASCII (0x20–0x7E) passes
 * through untouched; a few typographic characters map to ASCII fallbacks; any
 * remaining out-of-range character becomes '?'.
 *
 * TODO(M6): raster for non-Latin
 */
export function encodeText(s: string): Uint8Array {
  const out: number[] = [];
  for (const ch of s) {
    const mapped = FALLBACKS[ch] ?? ch;
    for (const c of mapped) {
      const code = c.charCodeAt(0);
      out.push(code >= 0x20 && code <= 0x7e ? code : 0x3f /* '?' */);
    }
  }
  return Uint8Array.from(out);
}

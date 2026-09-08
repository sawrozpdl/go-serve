/**
 * Display-name validation for the things a café names itself — menu items and
 * categories. Shared by web and mobile and mirrored in Go
 * (apps/api/internal/api/name.go). The Go copy is authoritative; this side
 * exists so the person typing finds out before they submit, not after.
 *
 * It exists because the three write paths disagreed: the web form sent the name
 * untrimmed, the mobile sheet trimmed it, and bulk import trimmed and deduped.
 * One column, three behaviours.
 *
 * Deliberately permissive about punctuation — a café that wants a drink called
 * "Cafe+Mocha (2-shot!)" is not making a mistake. What it refuses is what has no
 * business in a display name and breaks things downstream: whitespace runs
 * (which make two identical-looking names distinct rows), control characters (a
 * newline is a line feed on the ESC/POS docket), and format characters —
 * zero-width joiners/spaces and the bidi overrides, which make a name
 * unsearchable or reorder how the whole line renders.
 */

/** Runes, not bytes, so a Devanagari name gets the same allowance as an ASCII one. */
export const NAME_MAX = 80;

/** Shown under the field, and reused verbatim as the API's rejection message. */
export const NAME_HINT =
  'Use 1-80 characters. Punctuation is fine; line breaks and invisible characters are not.';

// Cc + Cf + Cs + Co: controls, format/bidi characters, surrogates, private use.
// The tab/newline family is handled before this so it becomes a separator.
const DROP = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}]/gu;
// Zs: NBSP and friends — they look like a space, so make them one.
const SPACEY = /[\t\n\r\v\f\p{Zs}]/gu;

/**
 * Fold a user-supplied display name to its storable form. Idempotent.
 *
 * NFC runs first so "é" typed as e + combining accent becomes the single code
 * point every search path will compare against — two names that look identical
 * must not be two rows.
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(SPACEY, ' ')
    .replace(DROP, '')
    .trim()
    .replace(/ {2,}/g, ' ');
}

/** True when `raw` is a display name we are willing to store. */
export function isValidName(raw: string): boolean {
  const v = normalizeName(raw);
  // Spread to count code points, not UTF-16 units — "अ".length is 1 but an
  // emoji's is 2, and the Go side counts runes.
  return v !== '' && [...v].length <= NAME_MAX;
}

/**
 * Quantity inputs (stock deltas, par levels, link quantities) are sent to the
 * API as strings and stored as Postgres `numeric`, so anything that isn't a
 * plain decimal number is rejected by the DB — which used to surface as a 500.
 * Phone keyboards are the usual culprit: `_` sits on the `-` key, and iOS
 * substitutes a typographic minus.
 *
 * Returns the normalized numeric string, or null when the input isn't a number.
 */
export function parseQtyInput(raw: string): string | null {
  // Only the minus look-alikes are corrected — anything else is reported rather
  // than silently reinterpreted (dropping the 'e' from "1e5" would give 15).
  const s = raw.replace(/[−–—_]/g, '-').replace(/\s/g, '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
  return s;
}

/**
 * onChange filter for quantity fields: folds the characters a phone keyboard
 * mistakes for a minus into '-' and drops anything a number can't contain, so
 * the correction is visible in the field instead of silently applied on submit.
 * Intermediate states ("", "-", "1.") are preserved while typing.
 */
export function normalizeQtyTyping(raw: string): string {
  return raw.replace(/[−–—_]/g, '-').replace(/[^0-9.+-]/g, '');
}

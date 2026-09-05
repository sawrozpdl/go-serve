/**
 * Phone validation, shared by web and mobile and mirrored in Go
 * (apps/api/internal/api/phone.go). The Go copy is authoritative — this side
 * exists so the person typing finds out before they submit, not after.
 *
 * Nepal-shaped, because that is who uses the product, with a deliberate escape
 * hatch: anything the user prefixes with '+' is treated as an international
 * number and only length-checked. Someone typing a country code knows what
 * they are doing; the rules below exist to catch "123" and a half-typed
 * number, not to refuse a supplier in Delhi.
 */

/** Digits, an optional single leading '+'. Formatting characters are dropped. */
export function normalizePhone(raw: string): string {
  const s = raw.trim();
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  return plus ? `+${digits}` : digits;
}

/**
 * True when `raw` is a phone number we are willing to store.
 *
 * Accepted:
 *   9843413772        Nepal mobile — 10 digits, 96/97/98
 *   +977 9843413772   the same with a country code
 *   01-4444444        Nepal landline — leading 0, 7-10 digits
 *   +91 9876543210    any '+' international number, 8-15 digits
 */
export function isValidPhone(raw: string): boolean {
  const v = normalizePhone(raw);
  if (v === '') return false;

  if (v.startsWith('+')) {
    const d = v.slice(1);
    // 977 is ours, so hold it to the national rules rather than the loose
    // international length check — otherwise "+977 123" would pass.
    if (d.startsWith('977')) return isNationalNepal(d.slice(3));
    return d.length >= 8 && d.length <= 15;
  }

  // A bare 977-prefixed number (someone omitted the '+').
  if (d977(v)) return isNationalNepal(v.slice(3));
  return isNationalNepal(v);
}

function d977(v: string): boolean {
  return v.startsWith('977') && v.length > 10;
}

function isNationalNepal(v: string): boolean {
  // Mobile: 10 digits, 96/97/98 prefix (NTC, Ncell, Smart).
  if (/^9[678]\d{8}$/.test(v)) return true;
  // Landline: area code with a leading 0, e.g. 01-4444444 or 061-520000.
  if (/^0\d{6,9}$/.test(v)) return true;
  return false;
}

/** Shown under the field, and reused as the API's rejection message. */
export const PHONE_HINT = 'Enter a 10-digit mobile (e.g. 9812345678) or a landline with its area code.';

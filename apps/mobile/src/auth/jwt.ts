/**
 * Pure JWT helpers — no crypto, just reading the (already server-verified)
 * access-token payload to know when to refresh. Kept dependency-free so it's
 * exhaustively unit-testable.
 */

/** Decode the `exp` claim (ms since epoch) from a JWT, or null if unreadable. */
export function decodeJwtExpMs(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    // base64url → base64, then decode. atob exists in Hermes (RN) and Node 20.
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { exp?: number };
    return typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Delay (ms) until we should proactively refresh: `leadMs` before expiry,
 * floored at `minMs` (avoid a tight loop right after a refresh) and capped at
 * the 32-bit setTimeout ceiling so a far-future exp can't overflow the timer.
 */
export function msUntilRefresh(
  expMs: number,
  now: number,
  leadMs = 60_000,
  minMs = 5_000,
): number {
  return Math.min(Math.max(expMs - now - leadMs, minMs), 0x7fffffff);
}

/**
 * True when the token is missing/undecodable or within `leadMs` of expiry —
 * i.e. we should refresh up front (e.g. on app foreground) before firing
 * requests that would otherwise 401.
 */
export function shouldRefreshNow(
  token: string | null,
  now: number,
  leadMs = 60_000,
): boolean {
  if (!token) return true;
  const expMs = decodeJwtExpMs(token);
  if (expMs == null) return true;
  return expMs - now < leadMs;
}

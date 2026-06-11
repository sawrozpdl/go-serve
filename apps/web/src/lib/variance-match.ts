/* Variance-match: when the counted drawer is short or over by EXACTLY one
 * payment's amount, the most likely cause is that payment having the wrong
 * method — the classic settle mistake this cafe keeps hitting.
 *
 * The math (variance = counted − expected; expected includes only cash
 * payments):
 *  - SHORT by X: expected contains cash that was never physically in the
 *    drawer → the candidate is a CASH payment of X that was actually paid
 *    online → flipping it to online drops expected by X and zeroes the
 *    variance.
 *  - OVER by X: the drawer holds cash that expected doesn't account for →
 *    the candidate is an ONLINE payment of X that was actually cash →
 *    flipping it to cash raises expected by X.
 *
 * Only returns a match when exactly ONE payment qualifies — two same-amount
 * candidates would make the suggestion a guess, so we stay silent.
 */

import type { ShiftPayment } from './api';

export function findVarianceMatch(
  payments: ShiftPayment[],
  variance: number | null,
): { payment: ShiftPayment; to: 'cash' | 'online' } | null {
  if (variance == null || variance === 0) return null;
  const abs = Math.abs(variance);
  const wantCash = variance < 0; // short → the mis-recorded one claims to be cash
  const candidates = payments.filter(
    (p) =>
      p.amount_cents === abs &&
      (wantCash ? p.method === 'cash' : p.method !== 'cash' && p.method !== 'house_tab'),
  );
  const only = candidates.length === 1 ? candidates[0] : undefined;
  if (!only) return null;
  return { payment: only, to: wantCash ? 'online' : 'cash' };
}

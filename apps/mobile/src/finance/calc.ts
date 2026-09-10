/**
 * Pure finance helpers for the shift + dashboard screens. No React, no I/O —
 * exhaustively unit-tested.
 */
import type { CashDropKind, PaymentMix, DailyPoint, Shift, ShiftPayment } from '@cafe-mgmt/api-types';

/** Cash-count variance: counted − expected. Positive = over, negative = short. */
export function cashVariance(countedCents: number, expectedCents: number): number {
  return Math.round(countedCents) - Math.round(expectedCents);
}

export type VarianceTone = 'balanced' | 'over' | 'short';

/** Classify a variance for display (a tiny tolerance counts as balanced). */
export function varianceTone(varianceCents: number, toleranceCents = 0): VarianceTone {
  if (Math.abs(varianceCents) <= toleranceCents) return 'balanced';
  return varianceCents > 0 ? 'over' : 'short';
}

/**
 * How seriously to take a variance, and what to say about it.
 *
 * The tone alone ("over" / "short") says nothing about whether Rs 20 is worth
 * a second look. Web's close panel grades it, and the grade is what turns a
 * number into an instruction:
 *
 *   0        — matches
 *   ≤ Rs 50  — coin rounding, get on with the day
 *   ≤ Rs 500 — investigate, then write down what you found
 *   > Rs 500 — stop and involve whoever runs the till
 *
 * The thresholds are deliberately absolute rupee amounts rather than a
 * percentage of takings: a Rs 600 hole is the same problem on a quiet Tuesday
 * as on a busy Friday, and scaling it by revenue would hide it exactly on the
 * days when most cash is moving.
 *
 * It never blocks a close. A shift that cannot be closed is a shift that gets
 * closed dishonestly.
 */
export type VarianceSeverity = 'ok' | 'minor' | 'warn' | 'bad';

const MINOR_LIMIT_CENTS = 5000; // Rs 50
const WARN_LIMIT_CENTS = 50000; // Rs 500

export function varianceSeverity(varianceCents: number): VarianceSeverity {
  const abs = Math.abs(varianceCents);
  if (abs === 0) return 'ok';
  if (abs <= MINOR_LIMIT_CENTS) return 'minor';
  if (abs <= WARN_LIMIT_CENTS) return 'warn';
  return 'bad';
}

/** The sentence that goes under the variance figure. */
export function varianceAdvice(severity: VarianceSeverity): string {
  switch (severity) {
    case 'ok':
      return 'Counted cash matches what the drawer should hold.';
    case 'minor':
      return 'Small difference — usually coin rounding. Worth a glance, not a hunt.';
    case 'warn':
      return 'Worth investigating. Note what you find before closing.';
    case 'bad':
      return 'Large difference — investigate and tell whoever runs the till before closing.';
  }
}

/** Whether the close note should be pressed for. Never enforced — see above. */
export function varianceNeedsNote(severity: VarianceSeverity): boolean {
  return severity === 'warn' || severity === 'bad';
}

/**
 * Variance-match: when the counted drawer is short or over by EXACTLY one
 * payment's amount, the most likely cause is that payment carrying the wrong
 * method — the classic settle mistake.
 *
 * The math (variance = counted − expected; expected counts only cash):
 *  - SHORT by X: expected contains cash that was never physically in the
 *    drawer → the candidate is a CASH payment of X that was actually paid
 *    online → flipping it to online drops expected by X and zeroes the
 *    variance.
 *  - OVER by X: the drawer holds cash expected doesn't account for → the
 *    candidate is an ONLINE payment of X that was actually cash → flipping it
 *    to cash raises expected by X.
 *
 * Only returns a match when exactly ONE payment qualifies — two same-amount
 * candidates would make the suggestion a guess, so we stay silent. Credit
 * (house_tab) charges never touch the drawer and are excluded.
 */
export function findVarianceMatch(
  payments: ShiftPayment[],
  varianceCents: number | null,
): { payment: ShiftPayment; to: 'cash' | 'online' } | null {
  if (varianceCents == null || varianceCents === 0) return null;
  const abs = Math.abs(varianceCents);
  const wantCash = varianceCents < 0; // short → the mis-recorded one claims to be cash
  const candidates = payments.filter(
    (p) =>
      p.amount_cents === abs &&
      (wantCash ? p.method === 'cash' : p.method !== 'cash' && p.method !== 'house_tab'),
  );
  if (candidates.length !== 1) return null;
  return { payment: candidates[0], to: wantCash ? 'online' : 'cash' };
}

/**
 * The most recently CLOSED shift — its counted cash is the cleanest signal of
 * what the drawer should hold, so it's what we recommend as the next opening
 * float. Ordered by `closed_at`, not by list position: the server returns
 * shifts newest-OPENED first, which picks the wrong row when shifts overlap or
 * are back-dated (the API's own computeDrawer sorts on closed_at too).
 */
export function latestClose(shifts: Shift[]): Shift | undefined {
  let best: Shift | undefined;
  for (const s of shifts) {
    if (!s.closed_at || s.closing_count_cents == null) continue;
    if (!best || s.closed_at > (best.closed_at as string)) best = s;
  }
  return best;
}

/** Split a payment mix into rounded percentages that sum to 100 (largest-
 * remainder), so the dashboard bar segments never over/underflow. */
export function paymentMixPercents(mix: PaymentMix): { cash: number; online: number; bank: number } {
  const raw = { cash: mix.cash_cents, online: mix.online_cents, bank: mix.bank_cents };
  const total = raw.cash + raw.online + raw.bank;
  if (total <= 0) return { cash: 0, online: 0, bank: 0 };
  const exact = {
    cash: (raw.cash / total) * 100,
    online: (raw.online / total) * 100,
    bank: (raw.bank / total) * 100,
  };
  const out = { cash: Math.floor(exact.cash), online: Math.floor(exact.online), bank: Math.floor(exact.bank) };
  let remainder = 100 - (out.cash + out.online + out.bank);
  // Hand the leftover points to the largest fractional parts first.
  const keys: ('cash' | 'online' | 'bank')[] = ['cash', 'online', 'bank'];
  keys.sort((a, b) => (exact[b] - out[b]) - (exact[a] - out[a]));
  for (const k of keys) {
    if (remainder <= 0) break;
    out[k] += 1;
    remainder -= 1;
  }
  return out;
}

export type Bar = { x: number; y: number; width: number; height: number };

/**
 * Lay out a simple bar chart for daily sales. Bars fill `width` with `gap`
 * between them; the tallest maps to `height`. Returns one Bar per point (x/y
 * from the top-left, SVG-style). An all-zero series yields zero-height bars.
 */
export function barGeometry(points: DailyPoint[], width: number, height: number, gap = 4): Bar[] {
  const n = points.length;
  if (n === 0 || width <= 0) return [];
  const max = Math.max(...points.map((p) => p.sales_cents), 0);
  const barWidth = Math.max(1, (width - gap * (n - 1)) / n);
  return points.map((p, i) => {
    const h = max > 0 ? (p.sales_cents / max) * height : 0;
    return { x: i * (barWidth + gap), y: height - h, width: barWidth, height: h };
  });
}

/**
 * A drawer movement that mirrors another record — a drawer-paid expense, an
 * inter-account transfer, or an owner draw. The owning record is what created
 * it, so removing the mirror alone would leave the two ledgers disagreeing.
 * These rows are shown but never deletable; the source is edited instead.
 */
export function isLinkedDrop(kind: CashDropKind): boolean {
  return kind === 'expense' || kind === 'transfer' || kind === 'owner_draw';
}

/** Where a linked drop is actually managed, so the UI can say so. */
export function linkedDropSource(kind: CashDropKind): string {
  switch (kind) {
    case 'expense':
      return 'Delete the expense to remove it.';
    case 'transfer':
      return 'Managed by the account transfer that created it.';
    default:
      return 'Owner cash movement — managed from the dashboard.';
  }
}

/** Human label for every drop kind the API can return, current or retired. */
const DROP_KIND_LABELS: Record<CashDropKind, string> = {
  owner_draw: 'Owner draw',
  bank_deposit: 'Bank deposit',
  expense: 'Expense',
  transfer: 'Transfer',
  paid_out: 'Paid out',
  paid_in: 'Paid in',
  petty_change: 'Petty change',
  correction: 'Correction',
  other: 'Other',
};

export function dropKindLabel(kind: CashDropKind): string {
  return DROP_KIND_LABELS[kind] ?? kind;
}

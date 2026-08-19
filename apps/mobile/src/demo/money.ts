/**
 * The settle quote, ported field-for-field from the Go handler
 * (apps/api/internal/api/payments.go buildQuote + pctOf + pctInclusive).
 *
 * Integer paisa throughout, and `Math.floor` rather than `Math.round`, because
 * that is what reproduces Go's half-up-on-positives: `(amount*n + 5000) / 10000`
 * in integer division already carries the +0.5. Rounding differently here would
 * make the demo's receipts disagree with its own dashboard by a paisa, which is
 * exactly the class of bug the real money-accuracy audit chased.
 *
 * One known divergence, harmless: the server sums `qty * unit_price_cents` in
 * numeric and casts once, while we sum already-rounded `line_cents`. The two can
 * differ by at most 1 paisa, and only for ½-plate quantities.
 */
import type { Order, OrderAdjustment, Payment, SettleQuote, VatMode } from '@cafe-mgmt/api-types';

/** "13.00" | "8.5" | "0" | "" → hundredths of a percent (1300 | 850 | 0 | 0). */
export function parsePctHundredths(pct: string): number {
  const s = (pct ?? '').trim();
  if (!s) return 0;
  const dot = s.indexOf('.');
  const whole = dot === -1 ? s : s.slice(0, dot);
  const frac = dot === -1 ? '' : s.slice(dot + 1);
  const w = Number.parseInt(whole || '0', 10);
  if (!Number.isFinite(w)) return 0;
  // Only two decimal places are meaningful (Postgres numeric(5,2)); anything
  // further is truncated, matching the Go parser.
  const f = Number.parseInt((frac + '00').slice(0, 2), 10);
  return w * 100 + (Number.isFinite(f) ? f : 0);
}

/** round(amount × pct / 100), half up, in integer paisa. */
export function pctOf(amount: number, pct: string): number {
  const n = parsePctHundredths(pct);
  return Math.floor((amount * n + 5000) / 10000);
}

/** Extract the VAT already embedded in a VAT-inclusive gross: round(gross × pct / (100 + pct)). */
export function pctInclusive(gross: number, pct: string): number {
  const n = parsePctHundredths(pct);
  if (n === 0) return 0;
  const denom = 10000 + n;
  return Math.floor((gross * n + Math.floor(denom / 2)) / denom);
}

export type QuoteRates = {
  service_charge_pct: string;
  vat_pct: string;
  vat_mode: VatMode;
};

export function buildQuote(
  order: Order,
  adjustments: OrderAdjustment[],
  payments: Payment[],
  rates: QuoteRates,
): SettleQuote {
  const items = order.items ?? [];
  const subtotal = items.filter((i) => !i.voided_at).reduce((sum, i) => sum + i.line_cents, 0);
  const discount = adjustments
    .filter((a) => a.order_id === order.id && a.type === 'discount')
    .reduce((sum, a) => sum + a.amount_cents, 0);
  // Every method counts toward paid, credit (house_tab) included — a tab charged
  // to an account is settled from the order's point of view.
  const paid = payments
    .filter((p) => p.order_id === order.id)
    .reduce((sum, p) => sum + p.amount_cents, 0);

  const service = pctOf(subtotal, rates.service_charge_pct);
  const base = Math.max(0, subtotal - discount + service);

  let tax = 0;
  let total = base;
  if (rates.vat_mode === 'inclusive') {
    tax = pctInclusive(base, rates.vat_pct);
  } else if (rates.vat_mode === 'exclusive') {
    tax = pctOf(base, rates.vat_pct);
    total = base + tax;
  }

  return {
    subtotal_cents: subtotal,
    discount_cents: discount,
    service_charge_cents: service,
    tax_cents: tax,
    total_cents: total,
    paid_cents: paid,
    balance_cents: total - paid,
    service_charge_pct: rates.service_charge_pct,
    vat_pct: rates.vat_pct,
    vat_mode: rates.vat_mode,
  };
}

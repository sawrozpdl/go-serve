/**
 * Pure ticket-total helpers. The tab used to print one line — a bare
 * "TOTAL" that was really just the subtotal — so a discount applied at the
 * till was invisible on the ticket and nobody was told VAT or a service
 * charge was still to come. Mirrors web's `tab-totals` block exactly.
 *
 * No React, no I/O: exhaustively unit-tested.
 */
import type { OrderAdjustment, VatMode } from '@cafe-mgmt/api-types';

/** Total discount applied to a tab, in cents. Non-discount adjustment types
 *  (service_charge, tax_override) are deliberately excluded — they are not
 *  money off, and folding them in here would misreport both. */
export function discountTotal(adjustments: OrderAdjustment[] | undefined): number {
  return (adjustments ?? [])
    .filter((a) => a.type === 'discount')
    .reduce((sum, a) => sum + a.amount_cents, 0);
}

/**
 * What the guest still has to be told about charges added after the ticket.
 *
 * Only promises charges the cafe actually levies: one with neither VAT nor a
 * service charge must not warn about them. Inclusive VAT is already inside the
 * printed prices, so it reads as a statement of fact rather than a warning
 * about something extra.
 *
 * Returns '' when there is nothing worth saying.
 */
export function checkoutChargesHint(
  vatMode: VatMode | undefined,
  vatPct: string | number | undefined,
  servicePct: string | number | undefined,
): string {
  const pct = (v: string | number | undefined) => {
    const n = typeof v === 'number' ? v : parseFloat(v ?? '0');
    return Number.isFinite(n) ? n : 0;
  };
  const mode = vatMode ?? 'none';
  const vatOn = mode !== 'none' && pct(vatPct) > 0;
  const svcOn = pct(servicePct) > 0;

  if (mode === 'inclusive' && vatOn) {
    return svcOn ? 'Prices include VAT · service charge at checkout' : 'Prices include VAT';
  }
  const charges = [vatOn ? 'VAT' : null, svcOn ? 'service charge' : null].filter(Boolean).join(' & ');
  return charges ? `${charges} applied at checkout` : '';
}

/** Subtotal less any discount, floored at zero — a discount larger than the
 *  tab must never render as a negative amount owed. */
export function afterDiscount(subtotalCents: number, discountCents: number): number {
  return Math.max(0, subtotalCents - discountCents);
}

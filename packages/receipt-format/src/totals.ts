import type { SettleQuote } from '@cafe-mgmt/api-types';

export type TotalRow = { label: string; cents: number; strong?: boolean };

export type ReceiptTotalsView = {
  rows: TotalRow[]; // ordered totals lines BEFORE the grand total
  totalCents: number; // grand total (= quote.total_cents)
  paidCents: number;
  balanceCents: number;
  showPaid: boolean; // paid_cents !== total_cents
  showBalance: boolean; // balance_cents !== 0
};

/** Trim a trailing-zero percentage string ("13.00" -> "13", "8.50" -> "8.5"). Non-numeric passes through. */
export function trimPct(s: string): string {
  const n = parseFloat(s);
  return Number.isFinite(n) ? String(n) : s;
}

/**
 * Deterministic money formatter (NO Intl — Hermes Intl is unreliable and tests
 * must be stable). 'Rs ' + rupees with comma thousands grouping, 2 decimals
 * ONLY when there's a paisa remainder, and a leading '-' for negatives.
 *   500 -> 'Rs 5'   12345 -> 'Rs 123.45'   100000 -> 'Rs 1,000'   -2500 -> '-Rs 25'
 */
export function formatReceiptMoney(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const rupees = Math.floor(abs / 100);
  const paisa = abs % 100;
  const grouped = String(rupees).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const amount = paisa === 0 ? grouped : `${grouped}.${String(paisa).padStart(2, '0')}`;
  return `${neg ? '-' : ''}Rs ${amount}`;
}

/**
 * Pure totals view mirroring web's receiptHTML VAT-mode branching. Discount row
 * cents is NEGATIVE; service/VAT labels include the trimmed pct. The grand total
 * ('TOTAL') is NOT in rows — the builder renders it separately.
 */
export function computeReceiptTotals(quote: SettleQuote): ReceiptTotalsView {
  const discountRow: TotalRow | undefined =
    quote.discount_cents > 0 ? { label: 'Discount', cents: -quote.discount_cents } : undefined;
  const serviceRow: TotalRow | undefined =
    quote.service_charge_cents > 0
      ? {
          label: `Service ${trimPct(quote.service_charge_pct)}%`,
          cents: quote.service_charge_cents,
        }
      : undefined;

  const rows: TotalRow[] = [];
  if (quote.vat_mode === 'none') {
    rows.push({ label: 'Subtotal', cents: quote.subtotal_cents });
    if (discountRow) rows.push(discountRow);
    if (serviceRow) rows.push(serviceRow);
  } else if (quote.vat_mode === 'exclusive') {
    rows.push({ label: 'Subtotal', cents: quote.subtotal_cents });
    if (discountRow) rows.push(discountRow);
    if (serviceRow) rows.push(serviceRow);
    rows.push({ label: `VAT ${trimPct(quote.vat_pct)}%`, cents: quote.tax_cents });
  } else {
    // inclusive
    const netRow: TotalRow = { label: 'Net', cents: quote.total_cents - quote.tax_cents };
    const vatRow: TotalRow = { label: `VAT ${trimPct(quote.vat_pct)}%`, cents: quote.tax_cents };
    if (quote.discount_cents > 0 || quote.service_charge_cents > 0) {
      rows.push({ label: 'Subtotal (incl. VAT)', cents: quote.subtotal_cents });
      if (discountRow) rows.push(discountRow);
      if (serviceRow) rows.push(serviceRow);
      rows.push(netRow, vatRow);
    } else {
      rows.push(netRow, vatRow);
    }
  }

  return {
    rows,
    totalCents: quote.total_cents,
    paidCents: quote.paid_cents,
    balanceCents: quote.balance_cents,
    showPaid: quote.paid_cents !== quote.total_cents,
    showBalance: quote.balance_cents !== 0,
  };
}

import { formatQty, type OrderItemRow, type SettleQuote, type PaymentMethod } from '@cafe-mgmt/api-types';
import { EscPosBuilder, twoCol } from './escpos/builder';
import { COLS } from './escpos/codepage';
import { computeReceiptTotals, formatReceiptMoney } from './totals';

export type ReceiptPayment = {
  method: PaymentMethod;
  amount_cents: number;
  reference_no?: string;
  house_tab_name?: string | null;
};

export type ReceiptArgs = {
  items: OrderItemRow[];
  quote: SettleQuote;
  payments: ReceiptPayment[];
  tableLabel: string;
  header: string;
  footer: string;
  width: '58' | '80';
  orderId: string;
  closedAt?: string | null;
  reprint?: boolean;
  now: Date; // INJECTED (do not call new Date() inside — keeps it testable)
};

export const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  online: 'Online',
  bank: 'Bank',
  esewa: 'eSewa',
  khalti: 'Khalti',
  card: 'Card',
  other: 'Other',
  house_tab: 'Credit',
};

/** Human label for a payment. Credit accounts append the account name; · is codepage-folded by encodeText. */
export function paymentLabel(p: ReceiptPayment): string {
  if (p.method === 'house_tab' && p.house_tab_name) {
    return `Credit · ${p.house_tab_name}`;
  }
  return PAYMENT_LABELS[p.method] ?? p.method;
}

// HH:mm 24h, zero-padded.
function fmtTime(now: Date): string {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Build a customer-receipt byte stream. Mirrors web receiptHTML — WITH prices
 * (unlike the KOT). VAT-mode-aware totals via computeReceiptTotals.
 */
export function buildReceiptCommands(args: ReceiptArgs): Uint8Array {
  const { items, quote, payments, tableLabel, header, footer, width, orderId, reprint, now } = args;
  const cols = COLS[width];
  const b = new EscPosBuilder(width);

  b.init();

  if (header.trim()) {
    b.align('center').bold(true);
    for (const l of header.split('\n')) b.line(l);
    b.bold(false);
  }

  if (reprint) {
    b.align('center').bold(true).line('** REPRINT **').bold(false);
  }

  b.rule('-');

  b.align('left');
  b.line(twoCol(tableLabel, fmtTime(now), cols));
  b.line(`#${orderId.slice(0, 8)}`);

  b.rule('-');

  for (const it of items) {
    if (it.voided_at) continue;
    // Itemise add-ons under the dish so the price is EXPLAINABLE — the same
    // breakdown web's receiptHTML prints, which the ESC/POS path used to skip.
    // With a breakdown the dish line shows the base alone and each add-on shows
    // what it added; the sub-lines therefore sum to the folded line_cents and
    // never change what is owed.
    const addOns = it.add_ons ?? [];
    const base = it.base_price_cents ?? it.unit_price_cents;
    const headCents = addOns.length > 0 ? base * it.qty : it.line_cents;
    b.line(twoCol(`${formatQty(it.qty, true)}x ${it.menu_item_name}`, formatReceiptMoney(headCents), cols));
    for (const a of addOns) {
      const label = `  + ${a.qty > 1 ? `${formatQty(a.qty, true)}x ` : ''}${a.name}`;
      // A free choice ("no ice") prints its name with no amount — a bare 0.00
      // reads as a charge the customer is about to look for.
      b.line(
        a.price_cents > 0
          ? twoCol(label, formatReceiptMoney(a.price_cents * a.qty * it.qty), cols)
          : label,
      );
    }
    if (it.notes?.trim()) b.line(`  > ${it.notes.trim()}`);
  }

  b.rule('-');

  const t = computeReceiptTotals(quote);
  for (const row of t.rows) {
    b.line(twoCol(row.label, formatReceiptMoney(row.cents), cols));
  }

  b.rule('-');

  b.bold(true).line(twoCol('TOTAL', formatReceiptMoney(t.totalCents), cols)).bold(false);

  b.rule('-');

  for (const p of payments) {
    const label = paymentLabel(p) + (p.reference_no ? ` · ${p.reference_no}` : '');
    b.line(twoCol(label, formatReceiptMoney(p.amount_cents), cols));
  }
  if (t.showPaid) b.line(twoCol('Paid', formatReceiptMoney(t.paidCents), cols));
  if (t.showBalance) b.line(twoCol('Balance', formatReceiptMoney(t.balanceCents), cols));

  if (footer.trim()) {
    b.feed(1).align('center');
    for (const l of footer.split('\n')) b.line(l);
  }

  b.feed(1).cut();

  return b.toBytes();
}

import { amountInWords, discountPercent, type CreditNote, type Invoice } from '@cafe-mgmt/api-types';
import { EscPosBuilder, twoCol, wrapLine } from './escpos/builder';
import { COLS } from './escpos/codepage';
import { formatReceiptMoney } from './totals';

/** The label the server returned for this print (POST /v1/invoices/:id/print). */
export type InvoiceLabel = {
  copy_no: number;
  /** ASCII title, e.g. "TAX INVOICE" (the Nepali title needs a raster font). */
  title: string;
  copy_label: string;
};

export type InvoiceArgs = {
  invoice: Invoice;
  label: InvoiceLabel;
  width: '58' | '80';
  /** Café's own footer (thank-you line), printed last. */
  footer?: string;
};

function fmtQty(q: string): string {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function trimRate(r: string): string {
  return r.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

// HH:mm of the issue instant in Nepal (UTC+05:45), independent of the phone's zone.
function npTime(iso: string): string {
  const d = new Date(new Date(iso).getTime() + (5 * 60 + 45) * 60_000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// "Label     value" on one line when it fits; otherwise the label, then the
// value wrapped and indented underneath (an address must never be cut).
function kvWriter(b: EscPosBuilder, cols: number) {
  return (k: string, v: string) => {
    if (k.length + 1 + v.length <= cols) {
      b.line(twoCol(k, v, cols));
      return;
    }
    b.line(`${k}:`);
    for (const l of wrapLine(v, cols - 2)) b.line(`  ${l}`);
  };
}

/**
 * Build an IRD invoice (procedure 2082 §6.2, Annex 6) as ESC/POS bytes.
 * Mirrors web lib/invoicePrint.ts. The title and copy marking come from the
 * server's print log — never decide them here. ASCII only: the codepage can't
 * carry Devanagari, so the Nepali title and seller name print on the web/A4
 * copy, not on the raw thermal path.
 */
export function buildInvoiceCommands(args: InvoiceArgs): Uint8Array {
  const { invoice: inv, label, width, footer } = args;
  const cols = COLS[width];
  const b = new EscPosBuilder(width);
  const kv = kvWriter(b, cols);
  const tax = inv.kind === 'tax_invoice';

  b.init().align('center').bold(true);
  for (const l of wrapLine(inv.seller_name, cols)) b.line(l);
  b.bold(false);
  for (const l of wrapLine(inv.seller_address, cols)) b.line(l);
  b.line(`PAN/VAT No: ${inv.seller_pan}`);
  if (inv.seller_phone) b.line(inv.seller_phone);
  b.feed(1).bold(true).doubleSize(true).line(label.title).doubleSize(false);
  b.line(`[ ${label.copy_label} ]`).bold(false);

  b.align('left').rule('-');
  kv('Bill No', inv.number);
  kv('Fiscal Year', inv.fiscal_year);
  kv('Txn date', `${inv.bs_date} BS`);
  kv('Issue date', `${inv.bs_date} BS ${npTime(inv.issued_at)}`);
  kv('AD date', inv.ad_date);
  kv('Buyer', inv.buyer_name || '-');
  if (inv.buyer_pan) kv('Buyer PAN', inv.buyer_pan);
  if (inv.buyer_address) kv('Address', inv.buyer_address);
  kv('Payment', inv.payment_method);
  if (inv.transaction_id) kv('Txn ID', inv.transaction_id);
  b.rule('-');

  for (const l of inv.lines) {
    b.line(twoCol(`${fmtQty(l.qty)}x ${l.description}`, formatReceiptMoney(l.amount_cents), cols));
  }
  if (tax) b.line('Prices include VAT');
  b.rule('-');

  const pct = discountPercent(inv.gross_cents, inv.discount_cents);
  if (tax) {
    b.line(twoCol('Amount (excl. VAT)', formatReceiptMoney(inv.gross_cents), cols));
    if (inv.discount_cents > 0) b.line(twoCol(`Discount (${pct}%)`, '-' + formatReceiptMoney(inv.discount_cents), cols));
    b.line(twoCol('Taxable amount', formatReceiptMoney(inv.taxable_cents), cols));
    if (inv.non_taxable_cents > 0) b.line(twoCol('Non-taxable', formatReceiptMoney(inv.non_taxable_cents), cols));
    b.line(twoCol(`VAT ${trimRate(inv.vat_rate)}%`, formatReceiptMoney(inv.vat_cents), cols));
  } else {
    b.line(twoCol('Amount', formatReceiptMoney(inv.gross_cents), cols));
    if (inv.discount_cents > 0) b.line(twoCol(`Discount (${pct}%)`, '-' + formatReceiptMoney(inv.discount_cents), cols));
  }
  b.rule('-');
  b.bold(true).line(twoCol('TOTAL', formatReceiptMoney(inv.total_cents), cols)).bold(false);
  for (const l of wrapLine(amountInWords(inv.total_cents), cols)) b.line(l);

  b.feed(1).align('center').qr(inv.qr_payload, width === '58' ? 4 : 6).feed(1);

  b.align('left').rule('-');
  b.line(`Issued by: ${inv.issued_by_name}`);
  b.line(inv.software_version);
  if (footer?.trim()) {
    b.feed(1).align('center');
    for (const l of footer.split('\n')) b.line(l);
  }
  b.feed(1).cut();
  return b.toBytes();
}

export type CreditNoteArgs = {
  note: CreditNote;
  label: InvoiceLabel;
  width: '58' | '80';
};

const REFUND_LABEL: Record<CreditNote['refund_method'], string> = {
  cash: 'Cash',
  online: 'Online',
  credit: 'Credit account',
  none: '-',
};

/**
 * Build a sales return / reverse entry (procedure 2082 §6.2(ज)) as ESC/POS
 * bytes. Mirrors web creditNoteHTML; like the invoice, the title and copy
 * marking come from the server's print log.
 */
export function buildCreditNoteCommands(args: CreditNoteArgs): Uint8Array {
  const { note: n, label, width } = args;
  const cols = COLS[width];
  const b = new EscPosBuilder(width);
  const kv = kvWriter(b, cols);
  const tax = n.vat_cents > 0 || n.taxable_cents > 0;

  b.init().align('center').bold(true);
  for (const l of wrapLine(n.seller_name, cols)) b.line(l);
  b.bold(false);
  for (const l of wrapLine(n.seller_address, cols)) b.line(l);
  b.line(`PAN/VAT No: ${n.seller_pan}`);
  b.feed(1).bold(true).doubleSize(true);
  for (const l of wrapLine(label.title, Math.floor(cols / 2))) b.line(l);
  b.doubleSize(false).line(`[ ${label.copy_label} ]`).bold(false);

  b.align('left').rule('-');
  kv('No', n.number);
  kv('Fiscal Year', n.fiscal_year);
  kv('Date', `${n.bs_date} BS ${npTime(n.issued_at)}`);
  kv('AD date', n.ad_date);
  kv('Against bill', n.invoice_number);
  kv('Bill FY', n.invoice_fiscal_year);
  kv('Bill date', `${n.invoice_bs_date} BS`);
  kv('Buyer', n.buyer_name || '-');
  if (n.buyer_pan) kv('Buyer PAN', n.buyer_pan);
  for (const l of wrapLine(`Reason: ${n.reason}`, cols)) b.line(l);
  b.rule('-');

  for (const l of n.lines) {
    b.line(twoCol(`${fmtQty(l.qty)}x ${l.description}`, formatReceiptMoney(l.amount_cents), cols));
  }
  b.rule('-');
  b.line(twoCol(tax ? 'Amount (excl. VAT)' : 'Amount', formatReceiptMoney(n.gross_cents), cols));
  if (n.discount_cents > 0) b.line(twoCol('Discount', '-' + formatReceiptMoney(n.discount_cents), cols));
  if (tax) {
    b.line(twoCol('Taxable amount', formatReceiptMoney(n.taxable_cents), cols));
    b.line(twoCol(`VAT ${trimRate(n.vat_rate)}%`, formatReceiptMoney(n.vat_cents), cols));
  }
  b.rule('-');
  b.bold(true).line(twoCol('TOTAL CREDITED', formatReceiptMoney(n.total_cents), cols)).bold(false);
  for (const l of wrapLine(amountInWords(n.total_cents), cols)) b.line(l);
  b.line(twoCol('Refunded by', REFUND_LABEL[n.refund_method], cols));

  b.feed(1).align('center').qr(n.qr_payload, width === '58' ? 4 : 6).feed(1);

  b.align('left').rule('-');
  b.line(`Issued by: ${n.issued_by_name}`);
  b.line(n.software_version);
  b.feed(1).cut();
  return b.toBytes();
}

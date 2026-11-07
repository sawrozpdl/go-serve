// IRD invoice rendering for thermal printers (procedure 2082 §6.2, Annex 6).
//
// The layout is fixed by what IRD requires on the bill, not by the café's
// receipt preferences: seller block with PAN, the title and copy marking the
// SERVER chose for this print (never decided here), bill number + fiscal year,
// BS and AD dates, buyer, payment method, lines, the IRD amount breakdown with
// the discount as a percentage, the amount in words, the dynamic QR, who
// issued it and when, and the software version. The café's own receipt
// footer is still printed underneath.

import QRCode from 'qrcode';
import {
  amountInWords,
  discountPercent,
  type Invoice,
  type InvoiceLine,
} from '@cafe-mgmt/api-types';
import { formatNPR } from '@/components/Money';
import { esc, printHTML, wrapDoc, type PrintWidth } from './printing';

/** The label the server returned for this print (POST /v1/invoices/:id/print). */
export type InvoicePrintLabel = {
  copy_no: number;
  title: string;
  title_ne: string;
  copy_label: string;
};

export type InvoicePrintArgs = {
  invoice: Invoice;
  label: InvoicePrintLabel;
  width: PrintWidth;
  /** Café's own footer text (thank-you line, Wi-Fi…), printed last. */
  footer?: string;
  /** Pre-rendered QR image (data URL); see invoiceQrDataUrl. */
  qrDataUrl?: string;
};

function fmtQty(q: string): string {
  const n = Number(q);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, '');
}

function trimRate(r: string): string {
  return r.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function npTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Kathmandu',
  });
}

function row(label: string, value: string, cls = ''): string {
  return `<div class="row ${cls}"><span>${esc(label)}</span><span class="r">${esc(value)}</span></div>`;
}

function lineRow(l: InvoiceLine): string {
  return `<div class="row item"><span class="name">${esc(fmtQty(l.qty))}× ${esc(l.description)}</span><span class="r">${formatNPR(l.amount_cents)}</span></div>`;
}

/** Render the QR payload to a PNG data URL (offline; no network). */
export async function invoiceQrDataUrl(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 1, width: 240 });
}

/** Build the printable invoice document. Pure given its inputs. */
export function invoiceHTML(args: InvoicePrintArgs): string {
  const { invoice: inv, label, width, footer, qrDataUrl } = args;
  const tax = inv.kind === 'tax_invoice';
  const issued = `${inv.bs_date} BS (${inv.ad_date})`;

  const buyer = [
    row('Buyer', inv.buyer_name || '—'),
    inv.buyer_pan ? row('Buyer PAN', inv.buyer_pan) : '',
    inv.buyer_address ? row('Address', inv.buyer_address) : '',
  ].join('');

  const pct = discountPercent(inv.gross_cents, inv.discount_cents);
  const totals = tax
    ? [
        row('Amount (excl. VAT)', formatNPR(inv.gross_cents)),
        inv.discount_cents > 0 ? row(`Discount (${pct}%)`, '-' + formatNPR(inv.discount_cents)) : '',
        row('Taxable amount', formatNPR(inv.taxable_cents)),
        inv.non_taxable_cents > 0 ? row('Non-taxable', formatNPR(inv.non_taxable_cents)) : '',
        row(`VAT ${trimRate(inv.vat_rate)}%`, formatNPR(inv.vat_cents)),
      ].join('')
    : [
        row('Amount', formatNPR(inv.gross_cents)),
        inv.discount_cents > 0 ? row(`Discount (${pct}%)`, '-' + formatNPR(inv.discount_cents)) : '',
      ].join('');

  const body = `
    <div class="center head">${esc(inv.seller_name)}</div>
    ${inv.seller_name_ne ? `<div class="center sub">${esc(inv.seller_name_ne)}</div>` : ''}
    <div class="center sub">${esc(inv.seller_address)}</div>
    <div class="center sub">PAN/VAT No: ${esc(inv.seller_pan)}${inv.seller_phone ? ` · ${esc(inv.seller_phone)}` : ''}</div>
    <div class="center inv-title">${esc(label.title)} / ${esc(label.title_ne)}</div>
    <div class="center"><span class="inv-copy">${esc(label.copy_label)}</span></div>
    <hr class="hr" />
    ${row('Bill No', inv.number)}
    ${row('Fiscal Year', inv.fiscal_year)}
    ${row('Transaction date', issued)}
    ${row('Invoice issue date', `${issued} ${npTime(inv.issued_at)}`)}
    ${buyer}
    ${row('Payment', inv.payment_method)}
    ${inv.transaction_id ? row('Txn ID', inv.transaction_id) : ''}
    <hr class="hr" />
    ${inv.lines.map(lineRow).join('')}
    ${tax ? '<div class="sub muted">Prices include VAT</div>' : ''}
    <hr class="hr" />
    ${totals}
    <hr class="hr" />
    ${row('TOTAL', formatNPR(inv.total_cents), 'total')}
    <div class="sub words">${esc(amountInWords(inv.total_cents))}</div>
    ${qrDataUrl ? `<div class="inv-qr"><img src="${esc(qrDataUrl)}" alt="Invoice QR" /></div>` : ''}
    <hr class="hr" />
    <div class="sub">Issued by: ${esc(inv.issued_by_name)}</div>
    <div class="sub muted">${esc(inv.software_version)}</div>
    ${footer?.trim() ? `<div class="center foot">${esc(footer.trim())}</div>` : ''}
  `;
  return wrapDoc(`${label.title} ${inv.number}`, body, width);
}

/** Render (with its QR) and send to the printer. */
export async function printInvoice(args: Omit<InvoicePrintArgs, 'qrDataUrl'>): Promise<void> {
  let qrDataUrl: string | undefined;
  try {
    qrDataUrl = await invoiceQrDataUrl(args.invoice.qr_payload);
  } catch {
    // A QR failure must not stop the bill printing; the fields are printed
    // as text above it anyway.
    qrDataUrl = undefined;
  }
  printHTML(invoiceHTML({ ...args, qrDataUrl }));
}

// Thermal-printer support — browser-only.
//
// We don't talk ESC/POS or touch the USB/serial bus; instead we render a
// narrow HTML slip and hand it to the OS via window.print() (same trick as
// PublicMenuShareModal's QR table-tent, but into a hidden iframe so there's
// no popup-blocker and no flashing window). Which physical printer the job
// lands on is the OS default printer on *this* device — JS can't choose it —
// so routing is per-device, configured via the device-role layer below.
//
// Whether the print dialog appears is also out of our hands: for hands-free
// printing the Android device must be set up for silent printing (RawBT print
// service, or a kiosk-printing browser, with the thermal printer as default).
// Without that, the slip still renders and print() still fires — the operator
// just confirms the dialog. The Reprint buttons cover the manual case.

import type { OrderItemRow, Payment, PaymentMethod, SettleQuote } from './api';
import { formatNPR } from '@/components/Money';

export type PrintWidth = '58' | '80';

// ---------------------------------------------------------------------------
// Device-role layer (localStorage, per browser)
//
// A device only auto-prints a slip when its role opts in — otherwise every
// tablet on the floor listening to the same order would spit out a duplicate.
// Default is off for both: adding the feature never surprises an existing
// device with unexpected printouts.
// ---------------------------------------------------------------------------

export type DevicePrintRole = { kitchen: boolean; receipt: boolean };

const ROLE_KEY = 'cafe.printRole';

export function getDeviceRole(): DevicePrintRole {
  try {
    const raw = localStorage.getItem(ROLE_KEY);
    if (!raw) return { kitchen: false, receipt: false };
    const parsed = JSON.parse(raw) as Partial<DevicePrintRole>;
    return { kitchen: !!parsed.kitchen, receipt: !!parsed.receipt };
  } catch {
    return { kitchen: false, receipt: false };
  }
}

export function setDeviceRole(role: DevicePrintRole): void {
  try {
    localStorage.setItem(ROLE_KEY, JSON.stringify(role));
  } catch {
    // private mode / storage disabled — auto-print just stays off
  }
}

// ---------------------------------------------------------------------------
// Low-level: render an HTML document into a throwaway hidden iframe and print
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** Wrap slip body markup in a full thermal document: monospace, fixed paper
 *  width, zero page margin so the printer driver doesn't add its own. */
function wrapDoc(title: string, body: string, width: PrintWidth): string {
  const fontPx = width === '58' ? 11 : 12;
  return `<!doctype html><html><head><meta charset="utf-8" />
<title>${esc(title)}</title>
<style>
  @page { size: ${width}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    width: ${width}mm;
    padding: 3mm 2mm;
    font-family: 'Menlo', 'Consolas', 'Courier New', monospace;
    font-size: ${fontPx}px;
    line-height: 1.35;
    color: #000;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .center { text-align: center; }
  .head { font-weight: 700; font-size: ${fontPx + 4}px; letter-spacing: .04em; }
  .sub { font-size: ${fontPx - 1}px; }
  .muted { color: #000; opacity: .75; }
  .banner { border: 1px solid #000; padding: 1px 4px; display: inline-block; font-weight: 700; }
  .hr { border: 0; border-top: 1px dashed #000; margin: 4px 0; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .row .r { text-align: right; white-space: nowrap; }
  .item { margin: 3px 0; }
  .item .name { font-weight: 700; }
  .item.big .name { font-size: ${fontPx + 3}px; }
  .note { padding-left: 10px; }
  .total { font-weight: 700; font-size: ${fontPx + 2}px; }
  .foot { margin-top: 6px; white-space: pre-wrap; }
  .pre { white-space: pre-wrap; }
</style></head>
<body>${body}</body></html>`;
}

function printHTML(docHtml: string): void {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(iframe);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    // Delay removal so the print job/dialog isn't torn down mid-flight.
    setTimeout(() => iframe.remove(), 1000);
  };

  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) {
      cleanup();
      return;
    }
    win.addEventListener('afterprint', cleanup, { once: true });
    try {
      win.focus();
      win.print();
    } catch {
      cleanup();
    }
    // Fallback if afterprint never fires (some Android webviews don't emit it).
    setTimeout(cleanup, 60_000);
  };

  iframe.srcdoc = docHtml;
}

// ---------------------------------------------------------------------------
// Slip rendering
// ---------------------------------------------------------------------------

function fmtTime(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** modifiers is a free-form jsonb (usually {}). Render whatever's there
 *  defensively without assuming a fixed shape. */
function modifiersText(mods: unknown): string {
  if (!mods || typeof mods !== 'object') return '';
  const parts = Array.isArray(mods)
    ? mods.map((m) => String(m))
    : Object.entries(mods as Record<string, unknown>).map(([k, v]) =>
        v === true ? k : `${k}: ${String(v)}`,
      );
  return parts.filter(Boolean).join(', ');
}

function itemBlock(it: OrderItemRow, big: boolean): string {
  const mods = modifiersText(it.modifiers);
  const note = (it.notes ?? '').trim();
  return `<div class="item${big ? ' big' : ''}">
    <div class="row"><span class="name">${it.qty}× ${esc(it.menu_item_name)}</span></div>
    ${mods ? `<div class="note muted">+ ${esc(mods)}</div>` : ''}
    ${note ? `<div class="note">» ${esc(note)}</div>` : ''}
  </div>`;
}

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  online: 'Online',
  esewa: 'eSewa',
  khalti: 'Khalti',
  card: 'Card',
  other: 'Other',
  house_tab: 'House tab',
};

function paymentLabel(p: Payment): string {
  const base = PAYMENT_LABELS[p.method] ?? p.method;
  if (p.method === 'house_tab' && p.house_tab_name) return `${base} · ${p.house_tab_name}`;
  return base;
}

// ---------------------------------------------------------------------------
// Public print actions
// ---------------------------------------------------------------------------

export type KitchenDocketArgs = {
  items: OrderItemRow[];
  tableLabel: string;
  width: PrintWidth;
  reprint?: boolean;
};

export type ReceiptArgs = {
  items: OrderItemRow[];
  quote: SettleQuote;
  payments: Payment[];
  tableLabel: string;
  header: string;
  footer: string;
  width: PrintWidth;
  orderId: string;
  closedAt?: string | null;
  reprint?: boolean;
};

/** Build the kitchen cook docket as a full printable document. */
export function kitchenDocketHTML(args: KitchenDocketArgs): string {
  const { items, tableLabel, width, reprint } = args;
  const body = `
    <div class="center head">KITCHEN</div>
    <div class="center sub">${esc(tableLabel)} · ${esc(fmtTime())}</div>
    ${reprint ? '<div class="center" style="margin-top:4px"><span class="banner">REPRINT</span></div>' : ''}
    <hr class="hr" />
    ${items.map((it) => itemBlock(it, true)).join('')}
    <hr class="hr" />
    <div class="center sub muted">${items.reduce((n, it) => n + it.qty, 0)} item(s)</div>
  `;
  return wrapDoc('Kitchen ticket', body, width);
}

/** Kitchen cook docket — what to make, for which table. No prices.
 *  Caller passes only the items going to the kitchen (auto-ready / voided
 *  items already filtered out). */
export function printKitchenDocket(args: KitchenDocketArgs): void {
  if (args.items.length === 0) return;
  printHTML(kitchenDocketHTML(args));
}

/** Build the customer receipt as a full printable document. */
export function receiptHTML(args: ReceiptArgs): string {
  const { items, quote, payments, tableLabel, header, footer, width, orderId, closedAt, reprint } =
    args;

  const billable = items.filter((it) => !it.voided_at);
  const totalRow = (label: string, value: number, cls = '') =>
    `<div class="row ${cls}"><span>${esc(label)}</span><span class="r">${formatNPR(value)}</span></div>`;

  // VAT-mode-aware totals. Discount/service rows are shared; the VAT treatment
  // differs: none shows nothing, exclusive adds a VAT line on top, inclusive
  // decomposes the total into Net + VAT (which sum to TOTAL).
  const discountRow = quote.discount_cents > 0 ? totalRow('Discount', -quote.discount_cents) : '';
  const serviceRow =
    quote.service_charge_cents > 0
      ? totalRow(`Service ${trimPct(quote.service_charge_pct)}%`, quote.service_charge_cents)
      : '';
  let totalsSection: string;
  if (quote.vat_mode === 'none') {
    totalsSection = `${totalRow('Subtotal', quote.subtotal_cents)}${discountRow}${serviceRow}`;
  } else if (quote.vat_mode === 'inclusive') {
    const netRow = totalRow('Net', quote.total_cents - quote.tax_cents);
    const vatRow = totalRow(`VAT ${trimPct(quote.vat_pct)}%`, quote.tax_cents);
    totalsSection =
      discountRow || serviceRow
        ? `${totalRow('Subtotal (incl. VAT)', quote.subtotal_cents)}${discountRow}${serviceRow}<hr class="hr" />${netRow}${vatRow}`
        : `${netRow}${vatRow}`;
  } else {
    totalsSection = `${totalRow('Subtotal', quote.subtotal_cents)}${discountRow}${serviceRow}${totalRow(
      `VAT ${trimPct(quote.vat_pct)}%`,
      quote.tax_cents,
    )}`;
  }

  const body = `
    ${header.trim() ? `<div class="center head pre">${esc(header.trim())}</div>` : ''}
    ${reprint ? '<div class="center" style="margin:4px 0"><span class="banner">REPRINT</span></div>' : ''}
    <hr class="hr" />
    <div class="row sub muted"><span>${esc(tableLabel)}</span><span class="r">${esc(fmtTime(closedAt))}</span></div>
    <div class="sub muted">#${esc(orderId.slice(0, 8))}</div>
    <hr class="hr" />
    ${billable
      .map(
        (it) => `<div class="row item">
          <span class="name">${it.qty}× ${esc(it.menu_item_name)}</span>
          <span class="r">${formatNPR(it.line_cents)}</span>
        </div>${(it.notes ?? '').trim() ? `<div class="note muted sub">» ${esc(it.notes.trim())}</div>` : ''}`,
      )
      .join('')}
    <hr class="hr" />
    ${totalsSection}
    <hr class="hr" />
    ${totalRow('TOTAL', quote.total_cents, 'total')}
    <hr class="hr" />
    ${payments
      .map(
        (p) => `<div class="row sub"><span>${esc(paymentLabel(p))}${
          p.reference_no ? ` · ${esc(p.reference_no)}` : ''
        }</span><span class="r">${formatNPR(p.amount_cents)}</span></div>`,
      )
      .join('')}
    ${quote.paid_cents !== quote.total_cents ? totalRow('Paid', quote.paid_cents) : ''}
    ${quote.balance_cents !== 0 ? totalRow('Balance', quote.balance_cents) : ''}
    ${footer.trim() ? `<div class="center foot">${esc(footer.trim())}</div>` : ''}
  `;
  return wrapDoc('Receipt', body, width);
}

/** Customer receipt — itemized totals + tendered payments. Built entirely
 *  from data already loaded on the settle screen, no extra fetch. */
export function printReceipt(args: ReceiptArgs): void {
  printHTML(receiptHTML(args));
}

/** A tiny sample slip so the operator can confirm the printer + paper width
 *  from Settings without ringing up a real order. */
export function testPrint(width: PrintWidth, header: string): void {
  const body = `
    ${header.trim() ? `<div class="center head pre">${esc(header.trim())}</div>` : '<div class="center head">TEST PRINT</div>'}
    <hr class="hr" />
    <div class="row"><span>Sample item</span><span class="r">${formatNPR(12500)}</span></div>
    <div class="row"><span>Another item ×2</span><span class="r">${formatNPR(8000)}</span></div>
    <hr class="hr" />
    <div class="row total"><span>TOTAL</span><span class="r">${formatNPR(20500)}</span></div>
    <hr class="hr" />
    <div class="center sub muted">${width}mm · ${esc(fmtTime())}</div>
  `;
  printHTML(wrapDoc('Test print', body, width));
}

/** Trim a trailing-zero percentage string ("13.00" → "13"). */
function trimPct(s: string): string {
  const n = parseFloat(s);
  return Number.isFinite(n) ? String(n) : s;
}

/** Resolve the configured paper width, defaulting to 80mm. */
export function receiptWidthOf(pref?: string): PrintWidth {
  return pref === '58' ? '58' : '80';
}

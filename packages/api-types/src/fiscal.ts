// IRD electronic billing (docs/ird/COMPLIANCE.md). Migration 0089 onward.

/** How a café is registered with IRD. */
export type FiscalRegistration = 'none' | 'pan' | 'vat';

/** Non-secret fiscal status every member sees on /v1/me. */
export type FiscalSummary = {
  registration_type: FiscalRegistration;
  /** True once the café has switched on IRD invoicing (one-way). */
  fiscal_mode: boolean;
  pan?: string;
  legal_name?: string;
};

/** One reason a café cannot (yet) switch on fiscal mode. */
export type FiscalProblem = {
  code: string;
  field?: string;
  message: string;
};

/** Owner-facing profile: GET/PATCH /v1/fiscal/profile. */
export type FiscalProfile = {
  registration_type: FiscalRegistration;
  pan: string;
  legal_name: string;
  legal_name_ne: string;
  address: string;
  phone: string;
  email: string;
  tax_office: string;
  permit_no: string;
  outlet_code: string;
  fiscal_mode: boolean;
  fiscal_mode_enabled_at: string | null;
  cbms_enabled: boolean;
  cbms_username: string;
  /** Whether a CBMS password is stored; the password itself is never returned. */
  cbms_password_set: boolean;
  /** Server-wide CBMS mode: 'off' (queue only), 'mock' (stand-in, never reported), 'live'. */
  cbms_mode: 'off' | 'mock' | 'live';
  /** This café's reporting backlog ('synced' counts real CBMS answers only). */
  cbms_counts: { pending: number; failed: number; synced: number };
  /** Empty once fiscal mode is on, or when nothing blocks enabling it. */
  readiness: FiscalProblem[];
};

export type FiscalProfilePatch = Partial<
  Pick<
    FiscalProfile,
    | 'registration_type'
    | 'pan'
    | 'legal_name'
    | 'legal_name_ne'
    | 'address'
    | 'phone'
    | 'email'
    | 'tax_office'
    | 'permit_no'
    | 'outlet_code'
  >
>;

/** Accepts "601234567" or "601-234-567"; returns the 9 digits or null. */
export function normalizePAN(input: string): string | null {
  const s = input.replace(/[\s-]/g, '');
  return /^[0-9]{9}$/.test(s) ? s : null;
}

/** Optional purchaser block captured at settle (a walk-in guest leaves it blank). */
export type FiscalBuyer = {
  name?: string;
  pan?: string;
  address?: string;
};

export type InvoiceLine = {
  line_no: number;
  description: string;
  /** numeric text, e.g. "1.00" or "0.50" */
  qty: string;
  /** As charged: VAT-inclusive for a VAT café. */
  unit_price_cents: number;
  amount_cents: number;
};

/** An issued IRD invoice (immutable). Amounts are paisa. */
export type Invoice = {
  id: string;
  order_id: string;
  /** 'tax_invoice' (VAT café) | 'invoice' (PAN-only café) */
  kind: 'tax_invoice' | 'invoice';
  /** "2083/84" */
  fiscal_year: string;
  seq: number;
  /** As printed, e.g. "42" or "KTM-42" */
  number: string;
  issued_at: string;
  /** Bikram Sambat issue date, "2083-07-21" */
  bs_date: string;
  ad_date: string;
  seller_pan: string;
  seller_name: string;
  seller_name_ne: string;
  seller_address: string;
  seller_phone: string;
  outlet_code: string;
  buyer_name: string;
  buyer_pan: string;
  buyer_address: string;
  /** Amount before discount, excluding VAT (Annex 5 "Amount"). */
  gross_cents: number;
  /** Discount excluding VAT. */
  discount_cents: number;
  taxable_cents: number;
  non_taxable_cents: number;
  vat_cents: number;
  total_cents: number;
  vat_rate: string;
  /** Annex 6 wording: Cash / Cheque / Credit / Other (comma-joined). */
  payment_method: string;
  transaction_id: string;
  issued_by_name: string;
  software_version: string;
  /** Frozen QR content; render it as-is. */
  qr_payload: string;
  content_hash: string;
  lines: InvoiceLine[];
};

/** A numbered kitchen order ticket (procedure 2082 §6.2(घ)). */
export type OrderSlip = {
  id: string;
  order_id: string;
  fiscal_year: string;
  seq: number;
  /** e.g. "KOT-17" or "KTM-KOT-17" */
  number: string;
  sent_at: string;
  bs_date: string;
  sent_by_name: string;
  lines: { order_item_id: string; name: string; qty: string; notes?: string; outlet_id?: string }[];
};

// ---------------------------------------------------------------------------
// Pure helpers shared by the web and mobile invoice renderers.
// ---------------------------------------------------------------------------

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n] ?? '';
  return (TENS[Math.floor(n / 10)] ?? '') + (n % 10 ? ' ' + (ONES[n % 10] ?? '') : '');
}

function belowThousand(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? (ONES[h] ?? '') + ' Hundred' : '', r ? belowHundred(r) : ''].filter(Boolean).join(' ');
}

/** Integer rupees in words on the Nepali/Indian scale (thousand, lakh, crore). */
export function rupeesInWords(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  n = Math.floor(n);
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  n %= 10_000_000;
  const lakh = Math.floor(n / 100_000);
  n %= 100_000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(rupeesInWords(crore) + ' Crore');
  if (lakh) parts.push(belowHundred(lakh) + ' Lakh');
  if (thousand) parts.push(belowHundred(thousand) + ' Thousand');
  if (n) parts.push(belowThousand(n));
  return parts.join(' ');
}

/** "Rupees One Thousand One Hundred Thirty and Fifty Paisa Only" (Annex 6 "In words"). */
export function amountInWords(cents: number): string {
  const rupees = Math.floor(Math.abs(cents) / 100);
  const paisa = Math.abs(cents) % 100;
  let s = 'Rupees ' + rupeesInWords(rupees);
  if (paisa) s += ' and ' + belowHundred(paisa) + ' Paisa';
  return s + ' Only';
}

/** Discount as a percentage of the pre-discount amount, 2 dp ("10.00"). */
export function discountPercent(grossCents: number, discountCents: number): string {
  if (grossCents <= 0 || discountCents <= 0) return '0.00';
  return ((discountCents * 100) / grossCents).toFixed(2);
}

/** One print of a fiscal document (append-only print log). */
export type PrintRecord = {
  copy_no: number;
  label: string;
  printed_by_name: string;
  device?: string;
  printed_at: string;
};

/** GET /v1/orders/:id/invoice and GET /v1/invoices/:id */
export type InvoiceView = {
  invoice: Invoice;
  prints: PrintRecord[];
  cbms?: CbmsSubmission;
  credit_notes: CreditNote[];
  /** false once the whole bill has been returned or reversed (Annex 5 Is_bill_Active) */
  active: boolean;
};

/** POST /v1/invoices/:id/print — print exactly this label. */
export type InvoicePrintResponse = {
  copy_no: number;
  title: string;
  title_ne: string;
  copy_label: string;
  invoice: Invoice;
};

/** CBMS reporting status of one document. */
export type CbmsSubmission = {
  status: 'pending' | 'synced' | 'failed';
  attempts: number;
  last_code?: number;
  last_error?: string;
  synced_at?: string;
  /** 'live' = the real CBMS host; 'mock' = the stand-in (not reported to IRD). */
  synced_via?: 'live' | 'mock';
  is_realtime?: boolean;
  next_attempt_at?: string;
};

/** POST /v1/fiscal/cbms/test */
export type CbmsConnectionResult = { ok: boolean; mode: string; code?: number; message: string };

export type CreditNoteLine = {
  line_no: number;
  invoice_line_no: number;
  description: string;
  qty: string;
  unit_price_cents: number;
  amount_cents: number;
};

/** A sales return (CN-n) or reverse entry (RE-n) against an issued invoice. */
export type CreditNote = {
  id: string;
  invoice_id: string;
  invoice_number: string;
  invoice_fiscal_year: string;
  invoice_bs_date: string;
  kind: 'sales_return' | 'reversal';
  fiscal_year: string;
  seq: number;
  number: string;
  issued_at: string;
  bs_date: string;
  ad_date: string;
  reason: string;
  seller_pan: string;
  seller_name: string;
  seller_address: string;
  buyer_name: string;
  buyer_pan: string;
  gross_cents: number;
  discount_cents: number;
  taxable_cents: number;
  non_taxable_cents: number;
  vat_cents: number;
  total_cents: number;
  vat_rate: string;
  refund_method: 'cash' | 'online' | 'credit' | 'none';
  issued_by_name: string;
  software_version: string;
  qr_payload: string;
  content_hash: string;
  reopened_order_id?: string;
  lines: CreditNoteLine[];
};

export type CreateCreditNoteVars = {
  invoiceId: string;
  kind: 'sales_return' | 'reversal';
  reason: string;
  /** sales_return only; omit to return everything not yet returned */
  lines?: { line_no: number; qty: string }[];
  refund_method: 'cash' | 'online' | 'credit';
  refund_reference?: string;
  /** reversal only: put the lines on a new open order to settle again */
  reopen?: boolean;
};

export type CreditNotePrintResponse = {
  copy_no: number;
  title: string;
  title_ne: string;
  copy_label: string;
  credit_note: CreditNote;
};

/** Supplier-bill detail of an expense, for the IRD purchase register (0094). */
export type PurchaseBill = {
  id: string;
  expense_id: string;
  supplier_name: string;
  supplier_pan: string;
  supplier_bill_no: string;
  supplier_bill_date_bs: string;
  supplier_bill_date: string;
  fiscal_year: string;
  is_import: boolean;
  customs_declaration_no: string;
  is_capital: boolean;
  total_cents: number;
  exempt_cents: number;
  taxable_cents: number;
  vat_cents: number;
  returned_cents: number;
  created_at: string;
};

export type PurchaseBillInput = {
  supplier_name: string;
  supplier_pan: string;
  supplier_bill_no: string;
  supplier_bill_date_bs: string;
  is_import: boolean;
  customs_declaration_no: string;
  is_capital: boolean;
  exempt_cents: number;
  taxable_cents: number;
  vat_cents: number;
  confirm_vat_mismatch?: boolean;
};

export type PurchaseReturnInput = {
  supplier_note_no?: string;
  reason: string;
  exempt_cents: number;
  taxable_cents: number;
  vat_cents: number;
};

export type PurchaseReturn = PurchaseReturnInput & {
  id: string;
  purchase_bill_id: string;
  fiscal_year: string;
  number: string;
  return_date_bs: string;
  total_cents: number;
};

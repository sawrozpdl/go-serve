// Tenant settings, preferences, and branding DTOs.
import type { StaffSchedule } from './staff';

export type MoodKey =
  | 'amber-dawn'
  | 'rose-bistro'
  | 'forest-cottage'
  | 'cobalt-modern'
  | 'crimson-trattoria'
  | 'mocha-warm'
  | 'midnight-jazz'
  | 'matcha-zen'
  | 'noir-speakeasy'
  | 'sunset-coast'
  | 'sakura-bloom'
  | 'desert-dune';

export type TypographyKey = 'editorial' | 'modern' | 'minimal';

export type TenantBranding = {
  brandPrimary?: string;
  brandAccent?: string;
  cafeName?: string;
  logoUrl?: string;
  wordmarkUrl?: string;
  mood?: MoodKey;
  tagline?: string;
  accentEmoji?: string;
  typography?: TypographyKey;
};

export type TenantPreferences = {
  /** When true, kitchen marking an item "ready" auto-advances it to
   *  "served" — collapses two clicks into one for cafes whose waiters
   *  hand off as soon as it's plated. */
  autoServeOnReady?: boolean;
  /** Tenant-wide default for skipping the cook step: items routed by it land
   *  in "ready" on send rather than "in_progress". Combined with
   *  autoServeOnReady, the tenant default becomes straight-serve. Overridable
   *  per category and per item via kitchen_behavior. */
  autoReadyOnSend?: boolean;
  /** When true, closing an order returns the table directly to free
   *  (skips the dirty hop + "mark clean" sweep). */
  autoCleanTables?: boolean;
  /** When true, the settle modal exposes discount controls inline so
   *  the cashier doesn't have to open two modals. */
  combinedSettle?: boolean;
  /** When true (default), tapping a menu item that already has a pending
   *  line bumps that line's qty rather than creating a duplicate row. */
  stackItems?: boolean;
  /** When true (default), discount amount field auto-applies after a
   *  short pause — no separate Apply tap. */
  discountAutoApply?: boolean;
  /** When true (default), typing into a payment method's amount field
   *  auto-records the payment after a short pause. No "Add payment" tap. */
  autoRecordPayment?: boolean;
  /** When true, settle modal shows the txn reference input on Online.
   *  Off by default so the cashier doesn't fight a field they rarely fill. */
  requireTxnRef?: boolean;
  /** Default discount UI state — saves the cashier from re-picking. */
  defaultDiscount?: {
    mode?: 'percent' | 'flat';
    reason?: string;
  };
  /** Cafe opening hours — same weekly shape as a staff schedule: day index
   *  "0"(Sun)–"6"(Sat) → time range. A missing key means closed that day.
   *  Used by the staff timeline to frame the day and judge coverage. */
  openingHours?: StaffSchedule;
  /** Staffing level the timeline treats as "comfortable" — slots below this
   *  during open hours are flagged. Purely informational, never enforced. */
  comfortCoverage?: number;
  /** Master switch for thermal-printer support. Off → no print actions show.
   *  Printing is a browser window.print() on the till device; see lib/printing.ts. */
  printingEnabled?: boolean;
  /** When true, sending a tab to the kitchen prints a cook docket (on devices
   *  whose local auto-print role includes kitchen). */
  printKitchenTicket?: boolean;
  /** When true, settling a tab prints a customer receipt (on devices whose
   *  local auto-print role includes receipt). */
  printCustomerReceipt?: boolean;
  /** Thermal paper width in mm — drives the @page size + line wrapping. */
  receiptWidth?: '58' | '80';
  /** Multiline header printed atop every receipt — name / address / phone /
   *  PAN-VAT no. Defaults to the workspace name when blank. */
  receiptHeader?: string;
  /** Multiline footer printed at the foot of every receipt (e.g. "Thank you!"). */
  receiptFooter?: string;
};

/** How VAT is applied for a tenant. 'none' hides all VAT wording in the UI;
 *  'inclusive' means menu prices already contain VAT (extracted on the bill);
 *  'exclusive' means VAT is added on top of the subtotal at close. */
export type VatMode = 'none' | 'inclusive' | 'exclusive';

export type TenantSettings = {
  id: string;
  slug: string;
  name: string;
  branding: TenantBranding;
  preferences: TenantPreferences;
  plan: string;
  status: string;
  timezone: string;
  vat_pct: string;
  vat_mode: VatMode;
  service_charge_pct: string;
  created_at: string;
};

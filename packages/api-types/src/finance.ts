// Shifts, cash drops, accounts, expenses, house tabs, and owner ledgers.
import type { PaymentMethod } from './orders';

export type Shift = {
  id: string;
  opened_by_user_id: string;
  opened_by_email?: string | null;
  opened_at: string;
  opening_float_cents: number;
  closed_by_user_id?: string | null;
  closed_at?: string | null;
  closing_count_cents?: number | null;
  expected_cash_cents?: number | null;
  variance_cents?: number | null;
  notes: string;
  live_expected_cash_cents: number;
  live_cash_count_cents: number;
  /** payments(method=cash) + Σ cash_drops(direction=in) */
  live_cash_in_cents: number;
  /** Σ cash_drops(direction=out) */
  live_cash_out_cents: number;
  /** Σ payments outside (cash, house_tab) — informational, not in expected cash. */
  live_online_in_cents?: number;
};

/** One settle event inside a shift — feeds the close panel's variance hint. */
export type ShiftPayment = {
  id: string;
  order_id: string;
  method: PaymentMethod;
  amount_cents: number;
  reference_no: string;
  recorded_at: string;
  table_name?: string | null;
};

// Cash drops — per-shift drawer ledger of cash moving in/out (0009).
export type CashDropDirection = 'out' | 'in';

export type CashDropKind =
  | 'owner_draw'
  | 'bank_deposit'
  | 'expense'
  | 'transfer'
  | 'paid_out'
  | 'paid_in'
  | 'petty_change'
  | 'correction'
  | 'other';

export type CashDrop = {
  id: string;
  shift_id: string;
  direction: CashDropDirection;
  kind: CashDropKind;
  amount_cents: number;
  reason: string;
  notes: string;
  expense_id?: string | null;
  expense_vendor?: string | null;
  recorded_by_user_id: string;
  recorded_by_email?: string | null;
  recorded_at: string;
};

export type CreateCashDropInput = {
  kind: CashDropKind;
  amount_cents: number;
  reason?: string;
  notes?: string;
  /** Only required when kind='correction' (other kinds infer direction). */
  direction?: CashDropDirection;
};

// Per-payment-method account balances + inter-account transfers (0009).
export type AccountBalance = {
  method: string;
  label: string;
  balance_cents: number;
  payments_cents: number;
  expenses_cents: number;
  transfers_in_cents: number;
  transfers_out_cents: number;
};

export type AccountTransfer = {
  id: string;
  from_method: string;
  to_method: string;
  amount_cents: number;
  fee_cents: number;
  reference_no: string;
  notes: string;
  transferred_at: string;
  shift_id?: string | null;
  cash_drop_id?: string | null;
  recorded_by_user_id: string;
  recorded_by_email?: string | null;
};

export type CreateTransferInput = {
  from_method: string;
  to_method: string;
  amount_cents: number;
  fee_cents?: number;
  reference_no?: string;
  notes?: string;
  transferred_at?: string;
};

export type ExpenseCategory = {
  id: string;
  name: string;
  color?: string | null;
  icon: string;
  is_active: boolean;
};

export type ExpenseAllocation = {
  id: string;
  expense_id: string;
  menu_category_id: string;
  menu_category_name?: string | null;
  share_pct: string;
  amount_cents: number;
};

export type Expense = {
  id: string;
  expense_category_id?: string | null;
  expense_category_name?: string | null;
  vendor: string;
  amount_cents: number;
  paid_at: string;
  payment_method: string;
  reference_no: string;
  receipt_url?: string | null;
  notes: string;
  linked_inventory_item_id?: string | null;
  linked_inventory_name?: string | null;
  recorded_by_user_id: string;
  created_at: string;
  paid_from: ExpensePaidFrom;
  owner_id?: string | null;
  owner_name?: string | null;
  /** Back-compat — derived from paid_from === 'drawer'. */
  paid_from_drawer: boolean;
  shift_id?: string | null;
  allocations?: ExpenseAllocation[];
};

export type ExpensePaidFrom = 'drawer' | 'bank' | 'owner' | 'owner_cash';

export type CreateExpenseInput = {
  expense_category_id?: string | null;
  vendor?: string;
  amount_cents: number;
  paid_at?: string;
  payment_method?: string;
  reference_no?: string;
  notes?: string;
  linked_inventory_item_id?: string | null;
  delta_units?: string;
  /** Where the money came from. Replaces the legacy paid_from_drawer flag. */
  paid_from?: ExpensePaidFrom;
  /**
   * Required when paid_from='owner' (owner advanced the cash, cafe owes them)
   * or paid_from='owner_cash' (owner spent cafe cash they were holding).
   */
  owner_id?: string | null;
  /** Back-compat: still accepted by the server. Use paid_from for new code. */
  paid_from_drawer?: boolean;
  allocations?: { menu_category_id: string; share_pct: string }[];
};

export type UpdateExpenseInput = {
  vendor?: string;
  expense_category_id?: string | null;
  /** Server treats null category as "keep" — set this to actually clear it. */
  clear_category?: boolean;
  amount_cents?: number;
  paid_at?: string;
  reference_no?: string;
  receipt_url?: string | null;
  notes?: string;
  allocations?: { menu_category_id: string; share_pct: string }[];
};

export type HouseTab = {
  id: string;
  name: string;
  notes: string;
  contact_phone: string;
  is_active: boolean;
  charged_cents: number;
  settled_cents: number;
  balance_cents: number;
  open_charge_count: number;
  created_at: string;
  archived_at?: string | null;
};

export type HouseTabCharge = {
  payment_id: string;
  order_id: string;
  service_table_name?: string | null;
  amount_cents: number;
  reference_no: string;
  recorded_at: string;
  is_opening_balance: boolean;
};

export type HouseTabSettlement = {
  id: string;
  amount_cents: number;
  payment_method: PaymentMethod;
  reference_no: string;
  notes: string;
  recorded_at: string;
};

export type HouseTabDetail = {
  house_tab: HouseTab;
  charges: HouseTabCharge[];
  settlements: HouseTabSettlement[];
};

export type OwnerLedgerKind = 'investment' | 'payout' | 'loan_advance' | 'loan_repayment';

export type CafeOwner = {
  id: string;
  user_id?: string | null;
  user_email?: string | null;
  display_name: string;
  share_units: number;
  active_from: string;
  active_to?: string | null;
  notes: string;
  created_at: string;
  lifetime_investment_cents: number;
  lifetime_payouts_cents: number;
  outstanding_loans_cents: number;
};

export type OwnerLedgerEntry = {
  id: string;
  owner_id: string;
  owner_name: string;
  kind: OwnerLedgerKind;
  amount_cents: number;
  occurred_at: string;
  notes: string;
  expense_id?: string | null;
  expense_vendor?: string | null;
  parent_loan_id?: string | null;
  is_correction: boolean;
  corrects_id?: string | null;
  created_by_user_id: string;
  created_by_email?: string | null;
  created_at: string;
  /** For loan_advance kind: how much of this loan has been repaid. */
  repaid_cents: number;
};

export type CafeBalance = {
  drawer_cents: number;
  drawer_source: 'live' | 'last_close' | 'none';
  drawer_as_of?: string;
  bank_cents: number;
  channels: AccountBalance[];
  /** Net cafe cash currently held by owners (taken from the drawer, unreconciled). */
  owner_cash_cents: number;
  total_cents: number;
  owner_outstanding: { loans_cents: number };
};

export type CafeSummary = {
  lifetime_invested_cents: number;
  lifetime_payouts_cents: number;
  outstanding_loans_cents: number;
  lifetime_revenue_cents: number;
  lifetime_direct_cogs_cents: number;
  lifetime_expenses_cents: number;
  cafe_net_profit_cents: number;
  cafe_balance_cents: number;
};

export type PayoutEntryInput = { owner_id: string; amount_cents: number };

export type OwnerCashKind = 'withdrawal' | 'bank_deposit' | 'cafe_expense' | 'return_to_drawer';

export type OwnerCashHolding = {
  owner_id: string;
  display_name: string;
  holding_cents: number;
  active: boolean;
};

export type OwnerCashEntry = {
  id: string;
  owner_id: string;
  owner_name: string;
  kind: OwnerCashKind;
  amount_cents: number;
  occurred_at: string;
  notes: string;
  reference_no: string;
  expense_id?: string | null;
  expense_vendor?: string | null;
  cash_drop_id?: string | null;
  shift_id?: string | null;
  created_by_user_id: string;
  created_by_email?: string | null;
  created_at: string;
};

export type OwnerCashResponse = {
  holdings: OwnerCashHolding[];
  entries: OwnerCashEntry[];
};

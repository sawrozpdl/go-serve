// Analytics and profitability report DTOs.
export type DashboardRange = 'today' | 'yesterday' | '7d' | '30d' | 'mtd' | 'ytd' | 'custom';

/** Explicit from/to (YYYY-MM-DD) used when a dashboard range is 'custom'. */
export type DashboardCustom = { from?: string; to?: string };

export type ProfitRange =
  | 'today'
  | 'yesterday'
  | 'dby'
  | 'thisweek'
  | 'mtd'
  | 'lastmonth'
  | 'ytd'
  | 'all'
  | 'custom';

export type DashboardKPIs = {
  sales_cents: number;
  /** Portion of sales_cents settled to house tabs — owed, not cash in hand. */
  tab_cents: number;
  tax_cents: number;
  service_cents: number;
  order_count: number;
  avg_ticket_cents: number;
  expenses_cents: number;
  net_cents: number;
  void_count: number;
  discount_cents: number;
};

export type DailyPoint = { day: string; sales_cents: number };

/** Cash-in-hand split of the collected portion of sales, for the Sales drill-down. */
export type PaymentMix = {
  cash_cents: number;
  bank_cents: number;
  /** online + legacy esewa/khalti/card/other, folded into one digital bucket. */
  online_cents: number;
};

/** One house tab and how much was charged to it in the period. */
export type TabBreakdownRow = {
  house_tab_id: string;
  name: string;
  amount_cents: number;
};

export type TopItemRow = {
  menu_item_id: string;
  name: string;
  category_name?: string | null;
  qty: number;
  revenue_cents: number;
};

export type ReportsDashboard = {
  range: string;
  from: string;
  to: string;
  timezone: string;
  kpis: DashboardKPIs;
  daily: DailyPoint[];
  top_sellers: TopItemRow[];
  slow_movers: TopItemRow[];
  payment_mix: PaymentMix;
  tab_breakdown: TabBreakdownRow[];
};

export type HourlyBucket = {
  hour: number; // 0..23 tenant-local
  order_count: number;
  revenue_cents: number;
};

export type HourlyResp = {
  date: string; // YYYY-MM-DD, tenant-local
  timezone: string;
  hours: HourlyBucket[];
};

export type TopSellerRow = {
  menu_item_id: string;
  name: string;
  icon: string;
  category_name?: string | null;
  qty: number;
  revenue_cents: number;
  prev_qty: number;
  prev_revenue_cents: number;
  delta_pct?: number | null;
};

export type TopSellersResp = {
  range: string;
  from: string;
  to: string;
  prev_from: string;
  prev_to: string;
  top: TopSellerRow[];
  bottom: TopSellerRow[];
};

export type HeatmapCell = {
  hour: number; // 0..23
  dow: number; // 0=Sun..6=Sat
  order_count: number;
  revenue_cents: number;
};

export type HeatmapResp = {
  range: string;
  from: string;
  to: string;
  timezone: string;
  cells: HeatmapCell[];
};

export type CategoryMixRow = {
  category_id: string;
  name: string;
  color?: string | null;
  icon: string;
  qty: number;
  revenue_cents: number;
  share_pct: number;
};

export type TableMixRow = {
  table_id: string;
  name: string;
  icon: string;
  capacity: number;
  order_count: number;
  revenue_cents: number;
  avg_ticket_cents: number;
};

export type VelocityPoint = {
  day: string;
  order_count: number;
  revenue_cents: number;
  avg_ticket_cents: number;
  items_total: number;
  items_per_order_x10: number;
};

export type VelocityResp = {
  range: string;
  from: string;
  to: string;
  timezone: string;
  series: VelocityPoint[];
  total_orders: number;
  total_revenue_cents: number;
  avg_ticket_cents: number;
  avg_items_per_order_x10: number;
};

export type ProfitRow = {
  menu_category_id?: string | null;
  name: string;
  revenue_cents: number;
  /** Total COGS = direct + allocated. */
  cogs_cents: number;
  /** Sum of qty × unit_cost_cents on closed-order items. */
  direct_cogs_cents: number;
  /** Sum of expense_allocations.amount_cents in window. */
  allocated_cogs_cents: number;
  gross_profit_cents: number;
  margin_pct?: number | null;
};

export type ProfitReport = {
  range: string;
  from: string;
  to: string;
  timezone: string;
  categories: ProfitRow[];
  totals: ProfitRow;
  unallocated_cogs_cents: number;
  /** Every non-deleted expense paid in the period (incl. salary/rent). */
  total_expenses_cents: number;
  /** Cash-basis bottom line = sales − total_expenses_cents. */
  net_profit_cents: number;
};

export type DrilldownExpense = {
  expense_id: string;
  paid_at: string;
  vendor: string;
  expense_amount_cents: number;
  share_pct: string;
  allocated_cents: number;
  notes: string;
};

export type DrilldownItem = {
  menu_item_id: string;
  name: string;
  qty: number;
  revenue_cents: number;
  cost_cents: number;
};

export type ProfitDrilldown = {
  range: string;
  from: string;
  to: string;
  category: ProfitRow;
  expenses: DrilldownExpense[];
  items: DrilldownItem[];
};

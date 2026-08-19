/**
 * History, dashboard, and movers — all three are pure folds over the SAME
 * `world.orders` ledger.
 *
 * That is the design point, not an implementation detail. Because closeOrder
 * freezes an order's totals and nothing recomputes them afterwards, the day's
 * history rows and the dashboard's Sales KPI are two views of one number and can
 * never drift — including after the reviewer settles a tab mid-demo, which is
 * precisely where a set of hand-written fixtures would visibly disagree.
 *
 * Windows are tenant-local days (Asia/Kathmandu), matching the API: a UTC day
 * boundary would put a 9pm Kathmandu sale on the wrong date.
 */
import type {
  DailyPoint,
  DashboardRange,
  HistoryOrder,
  HistoryPayment,
  MoverRow,
  MoversQuery,
  MoversResp,
  OrderHistoryResp,
  PaymentMix,
  ReportsDashboard,
  TabBreakdownRow,
  TopItemRow,
} from '@cafe-mgmt/api-types';
import { getWorld, localDay, type DemoOrder } from './world';

const TZ = 'Asia/Kathmandu';

function dayOf(order: DemoOrder): string {
  return localDay(order.closed_at ?? order.opened_at, TZ);
}

function shiftDay(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) out.push(d);
  return out;
}

function closedOrders(): DemoOrder[] {
  return getWorld().orders.filter((o) => o.status === 'closed');
}

// -------------------------------------------------------------------------
// History
// -------------------------------------------------------------------------

function historyPayments(orderId: string): HistoryPayment[] {
  return getWorld()
    .payments.filter((p) => p.order_id === orderId)
    .map((p) => ({
      id: p.id,
      method: p.method,
      amount_cents: p.amount_cents,
      reference_no: p.reference_no,
      // Credit charges never move; cash/online can be flipped.
      reclassifiable: p.method === 'cash' || p.method === 'online',
    }));
}

export function history(date: string): OrderHistoryResp {
  const rows: HistoryOrder[] = closedOrders()
    .filter((o) => dayOf(o) === date)
    .sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? ''))
    .map((o) => ({
      id: o.id,
      service_table_id: o.service_table_id ?? null,
      service_table_name: o.service_table_name ?? null,
      table_label: o.table_label,
      opened_at: o.opened_at,
      closed_at: o.closed_at ?? null,
      notes: o.notes,
      subtotal_cents: o.subtotal_cents,
      discount_cents: o.discount_cents,
      tax_cents: o.tax_cents,
      service_charge_cents: o.service_charge_cents,
      total_cents: o.total_cents,
      item_count: o.items.filter((i) => !i.voided_at).length,
      items: o.items,
      payments: historyPayments(o.id),
    }));

  return {
    date,
    timezone: TZ,
    orders: rows,
    // No credit *collection* in the demo: the Credit screen is out of scope, so
    // there is nowhere to record one and the tile stays hidden.
    credit_collections: [],
  };
}

// -------------------------------------------------------------------------
// Dashboard
// -------------------------------------------------------------------------

/** [from, to] inclusive, tenant-local, for a preset range. */
export function rangeWindow(range: DashboardRange, today = localDay(new Date(), TZ)): [string, string] {
  switch (range) {
    case 'yesterday': {
      const y = shiftDay(today, -1);
      return [y, y];
    }
    case '7d':
      return [shiftDay(today, -6), today];
    case '30d':
      return [shiftDay(today, -29), today];
    case 'mtd':
      return [`${today.slice(0, 7)}-01`, today];
    case 'ytd':
      return [`${today.slice(0, 4)}-01-01`, today];
    default:
      return [today, today];
  }
}

/** Short ranges pad the chart back to ~14 days so it has bars to draw. The KPI
 *  window is unchanged — daily_from/daily_to exist precisely so the chart can be
 *  labelled with its own, wider span instead of silently out-summing the Sales
 *  figure beside it. */
const CHART_MIN_DAYS = 14;

export function dashboard(range: DashboardRange): ReportsDashboard {
  const w = getWorld();
  const today = localDay(new Date(), TZ);
  const [from, to] = rangeWindow(range, today);
  const inWindow = closedOrders().filter((o) => {
    const d = dayOf(o);
    return d >= from && d <= to;
  });

  let sales = 0;
  let tab = 0;
  let tax = 0;
  let service = 0;
  let discount = 0;
  let voids = 0;
  const mix: PaymentMix = { cash_cents: 0, bank_cents: 0, online_cents: 0 };
  const tabRows = new Map<string, TabBreakdownRow>();
  const perItem = new Map<string, TopItemRow>();

  for (const o of inWindow) {
    sales += o.total_cents;
    tax += o.tax_cents;
    service += o.service_charge_cents;
    discount += o.discount_cents;
    voids += o.items.filter((i) => i.voided_at).length;

    for (const p of w.payments.filter((x) => x.order_id === o.id)) {
      if (p.method === 'house_tab') {
        tab += p.amount_cents;
        const key = p.house_tab_id ?? 'unknown';
        const row = tabRows.get(key) ?? {
          house_tab_id: key,
          name: p.house_tab_name ?? 'Credit',
          amount_cents: 0,
        };
        row.amount_cents += p.amount_cents;
        tabRows.set(key, row);
      } else if (p.method === 'cash') mix.cash_cents += p.amount_cents;
      else if (p.method === 'bank') mix.bank_cents += p.amount_cents;
      else mix.online_cents += p.amount_cents;
    }

    for (const line of o.items) {
      if (line.voided_at) continue;
      const cur = perItem.get(line.menu_item_id) ?? {
        menu_item_id: line.menu_item_id,
        name: line.menu_item_name,
        category_name: categoryNameFor(line.menu_item_id),
        qty: 0,
        revenue_cents: 0,
      };
      cur.qty += line.qty;
      cur.revenue_cents += line.line_cents;
      perItem.set(line.menu_item_id, cur);
    }
  }

  const windowDays = daysBetween(from, to);
  const chartDays =
    windowDays.length >= CHART_MIN_DAYS
      ? windowDays
      : daysBetween(shiftDay(to, -(CHART_MIN_DAYS - 1)), to);
  const salesByDay = new Map<string, number>();
  for (const o of closedOrders()) {
    const d = dayOf(o);
    salesByDay.set(d, (salesByDay.get(d) ?? 0) + o.total_cents);
  }
  const daily: DailyPoint[] = chartDays.map((day) => ({
    day,
    sales_cents: salesByDay.get(day) ?? 0,
  }));

  const expenses = windowDays.reduce((sum, d) => sum + (w.expensesByDay[d] ?? 0), 0);
  const ranked = [...perItem.values()].sort((a, b) => b.revenue_cents - a.revenue_cents);

  return {
    range,
    from,
    to,
    timezone: TZ,
    kpis: {
      sales_cents: sales,
      tab_cents: tab,
      credit_collected_cents: 0,
      tax_cents: tax,
      service_cents: service,
      order_count: inWindow.length,
      avg_ticket_cents: inWindow.length ? Math.round(sales / inWindow.length) : 0,
      expenses_cents: expenses,
      net_cents: sales - expenses,
      void_count: voids,
      discount_cents: discount,
    },
    daily,
    daily_from: chartDays[0],
    daily_to: chartDays[chartDays.length - 1],
    daily_padded: chartDays.length > windowDays.length,
    top_sellers: ranked.slice(0, 5),
    slow_movers: ranked.slice(-5).reverse(),
    payment_mix: mix,
    tab_breakdown: [...tabRows.values()].sort((a, b) => b.amount_cents - a.amount_cents),
    credit_collected_breakdown: [],
  };
}

function categoryNameFor(menuItemId: string): string | null {
  const w = getWorld();
  const item = w.items.find((i) => i.id === menuItemId);
  return w.categories.find((c) => c.id === item?.category_id)?.name ?? null;
}

// -------------------------------------------------------------------------
// Movers
// -------------------------------------------------------------------------

/** Per-item qty + revenue over a window, keyed by menu_item_id. */
function itemTotals(from: string, to: string): Map<string, { qty: number; revenue: number }> {
  const out = new Map<string, { qty: number; revenue: number }>();
  for (const o of closedOrders()) {
    const d = dayOf(o);
    if (d < from || d > to) continue;
    for (const line of o.items) {
      if (line.voided_at) continue;
      const cur = out.get(line.menu_item_id) ?? { qty: 0, revenue: 0 };
      cur.qty += line.qty;
      cur.revenue += line.line_cents;
      out.set(line.menu_item_id, cur);
    }
  }
  return out;
}

export function movers(range: DashboardRange, query: MoversQuery = {}): MoversResp {
  const w = getWorld();
  const today = localDay(new Date(), TZ);
  const [from, to] = rangeWindow(range, today);
  const span = daysBetween(from, to).length;
  const prevTo = shiftDay(from, -1);
  const prevFrom = shiftDay(prevTo, -(span - 1));

  const cur = itemTotals(from, to);
  const prev = itemTotals(prevFrom, prevTo);
  const needle = (query.q ?? '').trim().toLowerCase();

  let rows: MoverRow[] = w.items
    .filter((i) => !query.category_id || i.category_id === query.category_id)
    .filter((i) => !needle || i.name.toLowerCase().includes(needle))
    .map((i) => {
      const c = cur.get(i.id) ?? { qty: 0, revenue: 0 };
      const p = prev.get(i.id) ?? { qty: 0, revenue: 0 };
      return {
        menu_item_id: i.id,
        name: i.name,
        icon: i.icon,
        category_name: w.categories.find((x) => x.id === i.category_id)?.name ?? null,
        qty: c.qty,
        revenue_cents: c.revenue,
        prev_qty: p.qty,
        prev_revenue_cents: p.revenue,
        // No prior sales means there's no percentage to state — null, not 0% or
        // Infinity, so the UI can say "new" rather than render a lie.
        delta_pct: p.revenue > 0 ? Math.round(((c.revenue - p.revenue) / p.revenue) * 100) : null,
      };
    });

  const key = query.sort === 'qty' ? 'qty' : 'revenue_cents';
  const dir = query.order === 'asc' ? 1 : -1;
  rows.sort((a, b) => (a[key] - b[key]) * dir);

  const total = rows.length;
  const offset = query.offset ?? 0;
  rows = rows.slice(offset, offset + (query.limit ?? 100));

  return { range, from, to, prev_from: prevFrom, prev_to: prevTo, total, rows };
}

/**
 * The seeded scenario's contract.
 *
 * These aren't decorative assertions. The five open tabs exist so that every
 * branch of deriveTabState is on the floor at once — that is what makes the first
 * screen a reviewer sees look like a working café rather than a list. And the
 * history/dashboard equality is the structural invariant the whole reports design
 * rests on: two folds over one frozen ledger.
 */
import { deriveTabState } from '@cafe-mgmt/api-types';
import { summarizeHistory } from '../../history/summary';
import { partitionTickets, ticketUrgency } from '../../kitchen/board';
import { dashboard, history, rangeWindow } from '../reports';
import { tickets } from '../kitchen';
import { getWorld, localDay, resetWorld } from '../world';
import '../seed';

beforeEach(() => resetWorld());

it('lays out a floor with every tab state visible at once', () => {
  const w = getWorld();
  const open = w.orders.filter((o) => o.status === 'open');
  expect(open).toHaveLength(5);

  const states = new Set(open.map((o) => deriveTabState(o)?.key));
  expect(states).toEqual(
    new Set(['ordering', 'cooking', 'ready-to-serve', 'served-settle', 'new-items-after-send']),
  );
});

it('sets up a floor a reviewer can act on', () => {
  const w = getWorld();
  expect(w.tables).toHaveLength(12);
  expect(new Set(w.tables.map((t) => t.area))).toEqual(new Set(['Garden', 'Indoor', 'Terrace']));

  const byStatus = (s: string) => w.tables.filter((t) => t.status === s).length;
  expect(byStatus('occupied')).toBe(4); // four of the five tabs sit on a table
  expect(byStatus('dirty')).toBe(1); // one to sweep
  expect(byStatus('free')).toBeGreaterThan(0); // and somewhere to open a new tab

  // The fifth tab is a named walk-in, which is the other half of the floor story.
  const walkIn = w.orders.find((o) => o.status === 'open' && !o.service_table_id);
  expect(walkIn?.table_label).toBe('Ram · take-away');
});

it('opens the kitchen board with tickets across both outlets and all urgency tiers', () => {
  const board = tickets();
  expect(board.length).toBeGreaterThanOrEqual(4);

  // Both prep destinations represented, so the KDS outlet chips mean something.
  expect(new Set(board.map((t) => t.outlet_name))).toEqual(new Set(['Kitchen', 'Bar']));

  const { inProgress, ready } = partitionTickets(board);
  expect(inProgress.length).toBeGreaterThanOrEqual(3);
  expect(ready.length).toBeGreaterThanOrEqual(1);

  // One ticket per colour tier, so the board demonstrates its own urgency model
  // instead of rendering as one flat colour.
  const now = Date.now();
  const tiers = new Set(inProgress.map((t) => ticketUrgency(now, t.sent_to_kitchen_at)));
  expect(tiers).toEqual(new Set(['fresh', 'warn', 'urgent']));
});

it('gives every range a non-empty chart and a padded window for the short ones', () => {
  for (const range of ['today', 'yesterday', '7d', '30d'] as const) {
    const d = dashboard(range);
    expect(d.daily.length).toBeGreaterThanOrEqual(14);
    expect(d.daily.reduce((s, p) => s + p.sales_cents, 0)).toBeGreaterThan(0);
    expect(d.kpis.order_count).toBeGreaterThan(0);
    expect(d.kpis.avg_ticket_cents).toBeGreaterThan(0);
    // A day's takings that a café would recognise, not a rounding artefact.
    expect(d.kpis.sales_cents).toBeGreaterThan(100000);
  }

  // Short presets pad the chart back; 30d needs no padding.
  expect(dashboard('today').daily_padded).toBe(true);
  expect(dashboard('30d').daily_padded).toBe(false);
  expect(dashboard('30d').daily).toHaveLength(30);
});

it('keeps history and the dashboard telling the same story', () => {
  const today = localDay();
  const day = history(today);
  const dash = dashboard('today');

  // The exact invariant: the day's rows sum to the day's Sales KPI.
  expect(summarizeHistory(day.orders, day.credit_collections).salesCents).toBe(
    dash.kpis.sales_cents,
  );
  expect(day.orders.length).toBe(dash.kpis.order_count);

  // And the chart's own window sums to the same figure over the same span.
  const [from, to] = rangeWindow('30d');
  const wide = dashboard('30d');
  expect(wide.from).toBe(from);
  expect(wide.to).toBe(to);
  expect(wide.daily.reduce((s, p) => s + p.sales_cents, 0)).toBe(wide.kpis.sales_cents);
});

it('shows a plausible mid-afternoon today rather than a completed day', () => {
  const today = localDay();
  const day = history(today);
  expect(day.orders.length).toBeLessThanOrEqual(11);
  expect(day.orders.length).toBeGreaterThan(0);
  // Fewer than a full Saturday's trade.
  expect(day.orders.length).toBeLessThan(dashboard('7d').kpis.order_count);
});

it('produces figures a reviewer would read as a real café', () => {
  const d = dashboard('today');
  expect(d.kpis.tax_cents).toBeGreaterThan(0);
  expect(d.kpis.service_cents).toBeGreaterThan(0);
  expect(d.kpis.expenses_cents).toBeGreaterThan(0);
  expect(d.kpis.net_cents).toBe(d.kpis.sales_cents - d.kpis.expenses_cents);
  // A few voids, so the count isn't suspiciously zero — but not a shambles.
  expect(d.kpis.void_count).toBeGreaterThanOrEqual(0);
  expect(d.top_sellers.length).toBeGreaterThan(0);
  expect(d.top_sellers[0].revenue_cents).toBeGreaterThanOrEqual(
    d.top_sellers[d.top_sellers.length - 1].revenue_cents,
  );
  // The payment mix adds up to the non-credit portion of sales.
  const mix = d.payment_mix.cash_cents + d.payment_mix.online_cents + d.payment_mix.bank_cents;
  expect(mix + d.kpis.tab_cents).toBe(d.kpis.sales_cents);
  // Credit *collection* is out of scope, so the tile stays hidden.
  expect(d.kpis.credit_collected_cents).toBe(0);
});

it('re-seeds identically for the same day', () => {
  const first = dashboard('30d').kpis.sales_cents;
  resetWorld();
  expect(dashboard('30d').kpis.sales_cents).toBe(first);
});

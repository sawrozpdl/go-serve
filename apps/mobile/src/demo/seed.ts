/**
 * Builds the world a reviewer opens into.
 *
 * Two halves. The five OPEN tabs are hand-placed so that every branch of
 * deriveTabState is on screen at once — a floor where each tile is telling the
 * waiter something different is the fastest way to show what the product does.
 * The closed ledger behind them is generated, deterministically per calendar day,
 * so the dashboard has thirty days of plausible trading without thirty days of
 * hand-written fixtures.
 *
 * Determinism is per-day (seeded from the date string), so adding a day never
 * reshuffles the others and a reviewer who pulls-to-refresh never watches last
 * month's takings change.
 */
import type { DemoOrder, DemoWorld } from './world';
import { isoMinutesAgo, localDay, registerSeeder, uuid } from './world';
import {
  ID,
  ITEM_ID,
  TABLE_ID,
  demoCategories,
  demoHouseTabs,
  demoInventory,
  demoItems,
  demoMe,
  demoModifierGroups,
  demoOutlets,
  demoTables,
  demoTenant,
} from './fixtures';
import { intBetween, rngFrom, weighted, type Rng } from './rng';
import { buildQuote } from './money';
import type { Payment, PaymentMethod } from '@cafe-mgmt/api-types';
import { recomputeOrderDerived } from '../api/orderDerive';

const TZ = 'Asia/Kathmandu';
const LEDGER_DAYS = 30;

type LineSpec = {
  item: string;
  qty: number;
  status: 'pending' | 'in_progress' | 'ready' | 'served';
  /** Minutes ago the line was fired. Drives the KDS colour tiers. */
  sentMinsAgo?: number;
  notes?: string;
};

function makeWorld(): DemoWorld {
  return {
    tenant: demoTenant(),
    me: demoMe(),
    outlets: demoOutlets(),
    categories: demoCategories(),
    items: demoItems(),
    groups: demoModifierGroups(),
    inventory: demoInventory(),
    tables: demoTables(),
    houseTabs: demoHouseTabs(),
    orders: [],
    payments: [],
    adjustments: [],
    expensesByDay: {},
  };
}

function outletFor(w: DemoWorld, menuItemId: string): string | null {
  const item = w.items.find((i) => i.id === menuItemId);
  const cat = w.categories.find((c) => c.id === item?.category_id);
  return cat?.outlet_id ?? w.outlets.find((o) => o.is_default)?.id ?? null;
}

function buildOrder(
  w: DemoWorld,
  opts: {
    tableName?: string;
    label?: string;
    lines: LineSpec[];
    openedMinsAgo: number;
  },
): DemoOrder {
  const table = opts.tableName ? w.tables.find((t) => t.id === TABLE_ID[opts.tableName!]) : undefined;
  const order: DemoOrder = {
    id: uuid(),
    service_table_id: table?.id ?? null,
    service_table_name: table?.name ?? null,
    table_label: opts.label ?? '',
    status: 'open',
    opened_by_user_id: w.me.user_id,
    opened_at: isoMinutesAgo(opts.openedMinsAgo),
    closed_at: null,
    notes: '',
    subtotal_cents: 0,
    discount_cents: 0,
    tax_cents: 0,
    service_charge_cents: 0,
    total_cents: 0,
    live_subtotal_cents: 0,
    items: [],
    items_pending: 0,
    items_in_progress: 0,
    items_ready: 0,
    items_served: 0,
    items_total: 0,
    paid_cents: 0,
  };

  for (const spec of opts.lines) {
    const menuItem = w.items.find((i) => i.id === ITEM_ID[spec.item]);
    if (!menuItem) throw new Error(`demo seed: unknown item ${spec.item}`);
    const sentAt = spec.sentMinsAgo != null ? isoMinutesAgo(spec.sentMinsAgo) : null;
    order.items.push({
      id: uuid(),
      order_id: order.id,
      menu_item_id: menuItem.id,
      menu_item_name: menuItem.name,
      qty: spec.qty,
      unit_price_cents: menuItem.price_cents,
      base_price_cents: menuItem.price_cents,
      line_cents: Math.round(spec.qty * menuItem.price_cents),
      add_ons: [],
      modifiers: null,
      notes: spec.notes ?? '',
      kitchen_status: spec.status,
      sent_to_kitchen_at: sentAt,
      ready_at: spec.status === 'ready' || spec.status === 'served' ? sentAt : null,
      served_at: spec.status === 'served' ? sentAt : null,
      voided_at: null,
      void_reason: null,
      created_at: isoMinutesAgo(opts.openedMinsAgo),
      outlet_id: spec.status === 'pending' ? null : outletFor(w, menuItem.id),
    });
  }

  if (table && table.status === 'free') table.status = 'occupied';
  Object.assign(order, recomputeOrderDerived(order));
  return order;
}

/**
 * One open tab per deriveTabState branch. Read the right-hand column as the
 * reviewer's menu of things to try.
 */
function seedOpenTabs(w: DemoWorld): void {
  w.orders.push(
    // "2 not sent" — invites Send to kitchen.
    buildOrder(w, {
      label: 'Ram · take-away',
      openedMinsAgo: 3,
      lines: [
        { item: 'Cappuccino', qty: 2, status: 'pending' },
        { item: 'Butter Croissant', qty: 1, status: 'pending', notes: 'warmed' },
      ],
    }),
    // "3 cooking" — watch it age on the kitchen board. The follow-up line was
    // fired later, which is both realistic and what puts a FRESH ticket on the
    // board alongside the warn and urgent ones: the KDS colour tiers are
    // <6m fresh / 6-12m warn / >=12m urgent, and a board where every ticket is
    // the same colour shows none of that.
    buildOrder(w, {
      tableName: 'T3',
      openedMinsAgo: 12,
      lines: [
        { item: 'Chicken Momo', qty: 2, status: 'in_progress', sentMinsAgo: 8 },
        { item: 'Veg Thukpa', qty: 1, status: 'in_progress', sentMinsAgo: 8 },
        { item: 'Cheese Fried Rice', qty: 1, status: 'in_progress', sentMinsAgo: 3 },
      ],
    }),
    // "1 ready · serve" — one plated, one still late (14 min → urgent tier).
    buildOrder(w, {
      tableName: 'G1',
      openedMinsAgo: 18,
      lines: [
        { item: 'Cafe Latte', qty: 1, status: 'ready', sentMinsAgo: 2 },
        { item: 'Walnut Brownie', qty: 1, status: 'in_progress', sentMinsAgo: 14 },
      ],
    }),
    // "all served · settle" — the settle demo.
    buildOrder(w, {
      tableName: 'T5',
      openedMinsAgo: 46,
      lines: [
        { item: 'Chicken Momo', qty: 2, status: 'served', sentMinsAgo: 38 },
        { item: 'Espresso', qty: 2, status: 'served', sentMinsAgo: 38 },
        { item: 'Mocha', qty: 1, status: 'served', sentMinsAgo: 36 },
        { item: 'Banana Bread', qty: 1, status: 'served', sentMinsAgo: 36 },
      ],
    }),
    // "1 new · send to kitchen" — the add-after-send flow.
    buildOrder(w, {
      tableName: 'T1',
      openedMinsAgo: 24,
      lines: [
        { item: 'Cappuccino', qty: 1, status: 'served', sentMinsAgo: 20 },
        { item: 'Butter Croissant', qty: 1, status: 'served', sentMinsAgo: 20 },
        { item: 'Walnut Brownie', qty: 1, status: 'pending' },
      ],
    }),
  );

  // One table left dirty by a tab closed a little earlier, so the sweep gesture
  // has something to clean.
  const p2 = w.tables.find((t) => t.id === TABLE_ID.P2);
  if (p2) p2.status = 'dirty';
}

const ITEM_WEIGHTS: [name: string, weight: number][] = [
  ['Cappuccino', 16],
  ['Chicken Momo', 15],
  ['Butter Croissant', 13],
  ['Cheese Fried Rice', 10],
  ['Cafe Latte', 10],
  ['Espresso', 8],
  ['Veg Thukpa', 8],
  ['Walnut Brownie', 7],
  ['Mocha', 7],
  ['Banana Bread', 6],
];

/** Wall-clock instant for a tenant-local day + hour/minute. Kathmandu is UTC+5:45,
 *  which is exactly the sort of offset that makes "just subtract 6 hours" wrong. */
function localInstant(day: string, hour: number, minute: number): string {
  const utc = Date.parse(`${day}T00:00:00Z`) + (hour * 60 + minute - 345) * 60_000;
  return new Date(utc).toISOString();
}

function seedDay(w: DemoWorld, day: string, today: string): void {
  const rng: Rng = rngFrom(day);
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay();
  const isSaturday = dow === 6; // the Nepali weekend
  const base = intBetween(rng, 9, 18);
  const count = isSaturday ? Math.round(base * 1.4) : base;
  // Today is only part-way through: show a café that's mid-afternoon, not one
  // that has somehow already done a full day's trade.
  const orders = day === today ? Math.min(count, 11) : count;

  let expenses = 0;
  const names = ITEM_WEIGHTS.map(([n]) => n);
  const weights = ITEM_WEIGHTS.map(([, x]) => x);

  for (let n = 0; n < orders; n++) {
    const hour = intBetween(rng, 8, day === today ? 15 : 20);
    const minute = intBetween(rng, 0, 59);
    const closedAt = localInstant(day, hour, minute);
    const openedAt = new Date(Date.parse(closedAt) - intBetween(rng, 12, 55) * 60_000).toISOString();
    const table = w.tables[intBetween(rng, 0, w.tables.length - 1)];

    const order: DemoOrder = {
      id: uuid(),
      service_table_id: table.id,
      service_table_name: table.name,
      table_label: '',
      status: 'closed',
      opened_by_user_id: w.me.user_id,
      opened_at: openedAt,
      closed_at: closedAt,
      notes: '',
      subtotal_cents: 0,
      discount_cents: 0,
      tax_cents: 0,
      service_charge_cents: 0,
      total_cents: 0,
      live_subtotal_cents: 0,
      items: [],
      items_pending: 0,
      items_in_progress: 0,
      items_ready: 0,
      items_served: 0,
      items_total: 0,
      paid_cents: 0,
    };

    const lineCount = intBetween(rng, 2, 4);
    for (let l = 0; l < lineCount; l++) {
      const name = weighted(rng, names, weights);
      const menuItem = w.items.find((i) => i.id === ITEM_ID[name])!;
      const qty = rng() < 0.78 ? 1 : 2;
      // A few voids so the dashboard's void count isn't suspiciously zero.
      const voided = rng() < 0.04;
      order.items.push({
        id: uuid(),
        order_id: order.id,
        menu_item_id: menuItem.id,
        menu_item_name: menuItem.name,
        qty,
        unit_price_cents: menuItem.price_cents,
        base_price_cents: menuItem.price_cents,
        line_cents: qty * menuItem.price_cents,
        add_ons: [],
        modifiers: null,
        notes: '',
        kitchen_status: 'served',
        sent_to_kitchen_at: openedAt,
        ready_at: closedAt,
        served_at: closedAt,
        voided_at: voided ? closedAt : null,
        void_reason: voided ? 'wrong order' : null,
        created_at: openedAt,
        outlet_id: outletFor(w, menuItem.id),
      });
    }

    Object.assign(order, recomputeOrderDerived(order));
    // Freeze via the SAME quote the live settle flow uses, so a seeded order and
    // one the reviewer settles are priced identically.
    const q = buildQuote(order, [], [], {
      service_charge_pct: w.tenant.service_charge_pct,
      vat_pct: w.tenant.vat_pct,
      vat_mode: w.tenant.vat_mode,
    });
    order.subtotal_cents = q.subtotal_cents;
    order.service_charge_cents = q.service_charge_cents;
    order.tax_cents = q.tax_cents;
    order.total_cents = q.total_cents;
    order.paid_cents = q.total_cents;

    // 62% cash / 26% online / 8% split / 4% credit.
    const roll = rng();
    const push = (method: PaymentMethod, amount: number, tabId?: string) => {
      const tab = tabId ? w.houseTabs.find((t) => t.id === tabId) : undefined;
      const payment: Payment = {
        id: uuid(),
        order_id: order.id,
        method,
        amount_cents: amount,
        reference_no: method === 'online' ? `TXN${intBetween(rng, 10000, 99999)}` : '',
        house_tab_id: tab?.id ?? null,
        house_tab_name: tab?.name ?? null,
        recorded_by_user_id: w.me.user_id,
        recorded_at: closedAt,
      };
      w.payments.push(payment);
      if (tab) {
        tab.charged_cents += amount;
        tab.balance_cents += amount;
        tab.open_charge_count += 1;
      }
    };
    if (roll < 0.62) push('cash', q.total_cents);
    else if (roll < 0.88) push('online', q.total_cents);
    else if (roll < 0.96) {
      const cash = Math.round(q.total_cents / 2);
      push('cash', cash);
      push('online', q.total_cents - cash);
    } else push('house_tab', q.total_cents, rng() < 0.5 ? ID.tabStaff : ID.tabHotel);

    expenses += Math.round(q.total_cents * (0.3 + rng() * 0.15));
    w.orders.push(order);
  }

  w.expensesByDay[day] = expenses;
}

function seedLedger(w: DemoWorld): void {
  const today = localDay(new Date(), TZ);
  for (let back = LEDGER_DAYS - 1; back >= 0; back--) {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - back);
    seedDay(w, d.toISOString().slice(0, 10), today);
  }
}

export function seedWorld(): DemoWorld {
  const w = makeWorld();
  seedLedger(w);
  seedOpenTabs(w);
  // Newest first, matching the API's ordering.
  w.orders.sort((a, b) => (b.opened_at ?? '').localeCompare(a.opened_at ?? ''));
  return w;
}

registerSeeder(seedWorld);

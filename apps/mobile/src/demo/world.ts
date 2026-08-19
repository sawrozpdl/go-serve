/**
 * The demo backend's state.
 *
 * A plain mutable module object, not a store. Nothing subscribes to it: every
 * screen reads through react-query, and the existing hooks already invalidate the
 * right keys after each mutation — so the world only has to be synchronously
 * readable by demoRequest. A zustand store would buy reactivity nobody uses plus
 * immutable-spread ceremony over a several-hundred-order ledger.
 *
 * Nor is it persisted. Seeded timestamps are `now`-relative (kitchen ticket ages
 * drive the KDS colour tiers), so a world resumed the next morning would show
 * every ticket as hours overdue — which reads as broken. A cold start re-seeds a
 * café that is plausibly mid-afternoon *today*, and the demo flag isn't persisted
 * either, so a relaunch lands on login instead.
 *
 * Seeding is LAZY, inside getWorld(). src/api/client.ts imports this module
 * statically, so a module-scope seed would run in every api test.
 */
import type {
  HouseTab,
  InventoryItem,
  Me,
  MenuCategory,
  MenuItem,
  ModifierGroup,
  Order,
  OrderAdjustment,
  OrderItemRow,
  Outlet,
  Payment,
  ServiceTable,
  TenantSettings,
} from '@cafe-mgmt/api-types';
import { notFound } from './errors';

/** An order line plus the prep outlet stamped onto it at send-to-kitchen. The
 *  server keeps this on order_items; the DTO exposes it only on KitchenTicket, so
 *  the demo carries it here and projects it onto the ticket. */
export type DemoOrderItem = OrderItemRow & { outlet_id?: string | null };
export type DemoOrder = Order & { items: DemoOrderItem[] };

export type DemoWorld = {
  tenant: TenantSettings;
  me: Me;
  outlets: Outlet[];
  categories: MenuCategory[];
  items: MenuItem[];
  groups: ModifierGroup[];
  inventory: InventoryItem[];
  tables: ServiceTable[];
  houseTabs: HouseTab[];
  /** One ledger for open, closed and cancelled orders. History and the dashboard
   *  are two folds over THIS array, which is why their numbers can't drift. */
  orders: DemoOrder[];
  payments: Payment[];
  adjustments: OrderAdjustment[];
  /** Tenant-local YYYY-MM-DD → total expense paisa. Dashboard-only; there is no
   *  Expenses screen in the demo's scope. */
  expensesByDay: Record<string, number>;
};

let world: DemoWorld | null = null;

/** Counter behind uuid(). Module-level rather than a world field on purpose:
 *  seed.ts mints ids while the world is still being built, so reading it through
 *  getWorld() would recurse. */
let seq = 0;

/** Set by seed.ts to avoid a circular import (seed needs the world's types). */
let seeder: (() => DemoWorld) | null = null;
export function registerSeeder(fn: () => DemoWorld): void {
  seeder = fn;
}

export function getWorld(): DemoWorld {
  if (!world) {
    if (!seeder) throw new Error('demo world seeder not registered');
    world = seeder();
  }
  return world;
}

/** Drop the world so the next touch re-seeds. Called on entering demo mode. */
export function resetWorld(): void {
  world = null;
  seq = 0;
}

/** Unique id. Not a real v4 — nothing here validates them, and a counter keeps a
 *  re-seeded world reproducible for the tests. */
export function uuid(): string {
  seq += 1;
  return `d0000000-0000-4000-8000-${seq.toString(16).padStart(12, '0')}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoMinutesAgo(mins: number): string {
  return new Date(Date.now() - mins * 60_000).toISOString();
}

/** Tenant-local YYYY-MM-DD for an instant. The demo tenant is Asia/Kathmandu, and
 *  history/dashboard windows are tenant-local days — the same distinction that has
 *  bitten the real reports more than once. */
export function localDay(at: Date | string = new Date(), timeZone = 'Asia/Kathmandu'): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  // en-CA formats as YYYY-MM-DD, which is what the API's date params use.
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(d);
}

export function findOrder(id: string): DemoOrder {
  const o = getWorld().orders.find((x) => x.id === id);
  if (!o) throw notFound();
  return o;
}

export function findTable(id: string | null | undefined): ServiceTable | undefined {
  if (!id) return undefined;
  return getWorld().tables.find((t) => t.id === id);
}

export function categoryOf(item: MenuItem | undefined): MenuCategory | undefined {
  if (!item) return undefined;
  return getWorld().categories.find((c) => c.id === item.category_id);
}

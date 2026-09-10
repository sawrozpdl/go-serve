/**
 * What "Inherit" actually resolves to, and what a price and cost imply.
 *
 * Kitchen routing and prep outlet both cascade item → category → tenant
 * default. "Inherit" is therefore honest but useless on its own: the operator
 * setting up a drinks item cannot see whether inheriting means the drink goes
 * to the kitchen board or straight to the customer. Naming the resolved value
 * beside the choice is the whole point of these helpers.
 */
import type { KitchenBehavior, MenuCategory, Outlet } from '@cafe-mgmt/api-types';

/** Labels for the routings that are an actual instruction, not a deferral. */
export const KITCHEN_BEHAVIOR_LABELS: Record<Exclude<KitchenBehavior, 'inherit'>, string> = {
  cook: 'Send to kitchen',
  ready: 'Mark ready on send',
  serve: 'Serve immediately',
};

export function behaviorLabel(behavior: KitchenBehavior): string {
  return behavior === 'inherit'
    ? 'Inherit'
    : (KITCHEN_BEHAVIOR_LABELS[behavior] ?? behavior);
}

/**
 * The "Inherit" option's label on an ITEM, naming the category's own setting
 * when the category has one. When the category also inherits, there is
 * nothing more specific to say — the tenant default is a Settings-level
 * choice and quoting it here would go stale the moment it changed.
 */
export function inheritedBehaviorLabel(category: MenuCategory | undefined): string {
  const b = category?.kitchen_behavior;
  return b && b !== 'inherit'
    ? `Inherit from category (${KITCHEN_BEHAVIOR_LABELS[b]})`
    : 'Inherit from category';
}

/**
 * Which outlet an item actually lands on when it inherits.
 *
 * Mirrors the server's own resolution exactly —
 * `COALESCE(item.outlet_id, category.outlet_id, default)` in orders.go — and
 * that COALESCE deliberately does NOT skip an inactive outlet. So a category
 * pointed at a station someone has since turned off keeps routing there, and
 * its tickets land on a board nobody is watching. Returning the resolved
 * outlet (rather than just a name) lets the form say so out loud instead of
 * quietly showing the fallback the UI wishes were true.
 */
export function resolveOutlet(
  category: MenuCategory | undefined,
  outlets: Outlet[] | undefined,
): Outlet | undefined {
  const all = outlets ?? [];
  const id = category?.outlet_id ?? all.find((o) => o.is_default)?.id;
  return all.find((o) => o.id === id);
}

/** The tenant's fallback station, for a category that inherits. */
export function defaultOutlet(outlets: Outlet[] | undefined): Outlet | undefined {
  return (outlets ?? []).find((o) => o.is_default);
}

/** A station's name, saying plainly when it is switched off. */
export function outletLabel(outlet: Outlet | undefined): string | undefined {
  if (!outlet) return undefined;
  return outlet.is_active ? outlet.name : `${outlet.name} — turned off`;
}

export type Margin = { pct: number; perSaleCents: number };

/**
 * Gross margin for one sale. Null when either side is unknown — a margin
 * against a zero price is a division, not a fact.
 *
 * A cost above the price yields a NEGATIVE margin rather than nothing: an item
 * being sold at a loss is exactly what this hint exists to surface.
 */
export function itemMargin(priceCents: number, costCents: number): Margin | null {
  if (priceCents <= 0 || costCents <= 0) return null;
  return {
    pct: Math.round(((priceCents - costCents) / priceCents) * 100),
    perSaleCents: priceCents - costCents,
  };
}

/**
 * Filter the catalog by a typed query, matching name, SKU and description.
 *
 * Case- and whitespace-insensitive, and matching anywhere rather than only at
 * the start: an operator looking for "momo" should find "Jhol Momo".
 */
export function matchesQuery(
  item: { name: string; sku?: string | null; description?: string },
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [item.name, item.sku ?? '', item.description ?? '']
    .some((field) => field.toLowerCase().includes(q));
}

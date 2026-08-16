// Menu categories, items, kitchen-routing helpers, and bulk import DTOs.
import type { TenantPreferences } from './tenant';

/** Kitchen routing on send-to-kitchen. 'inherit' defers to the parent level
 *  (item → category → tenant default). 'cook' = normal in_progress ticket,
 *  'ready' = skip cooking (lands in the Ready column), 'serve' = skip kitchen
 *  and serving entirely (the old per-item auto_ready behaviour). */
export type KitchenBehavior = 'inherit' | 'cook' | 'ready' | 'serve';

export type MenuCategory = {
  id: string;
  name: string;
  sort: number;
  color?: string | null;
  /** Lucide icon name (e.g. "Coffee"). Empty string = no icon. */
  icon: string;
  /** Optional banner image (object URL) shown on the public customer menu.
   *  Send "" to clear on update, a URL to set, or omit to leave as-is. */
  image_url?: string | null;
  is_active: boolean;
  /** Default kitchen routing for this category's items; items may override. */
  kitchen_behavior: KitchenBehavior;
  /** Prep outlet this category's items route to (Kitchen, Bar…). null =
   *  inherit the tenant's default outlet; an item may override per-item. */
  outlet_id?: string | null;
  /** Live count of non-deleted menu items in this category. */
  item_count: number;
  /** Add-on groups applied to EVERY item in this category ("all drinks can
   *  have an extra shot"). Composes with each item's own groups — see
   *  resolveModifierGroups. Always an array. */
  modifier_group_ids: string[];
};

export type MenuItem = {
  id: string;
  category_id: string;
  name: string;
  description: string;
  price_cents: number;
  /** Cafe's own per-unit cost (production / wholesale). null = unset.
   *  Captured onto order_items at sale time so historical reports stay
   *  stable even if you tune the cost later. */
  cost_cents?: number | null;
  sku?: string | null;
  image_url?: string | null;
  /** Lucide icon name. Empty = no icon set. */
  icon: string;
  is_active: boolean;
  /** Operator-pinned: surfaces in the "Frequently used" row before there's
   *  enough order history. Auto-improves once velocity ranking kicks in. */
  is_featured: boolean;
  /** Per-item kitchen routing override; 'inherit' follows the category then
   *  the tenant default. 'serve' is the old auto_ready (straight-serve). */
  kitchen_behavior: KitchenBehavior;
  /** Per-item prep outlet override. null = inherit (category → tenant default). */
  outlet_id?: string | null;
  /** Opt-in to fractional (½-step) quantities for this item — e.g. half a
   *  plate of momo. When false the POS + API only accept whole numbers. */
  allow_half: boolean;
  sort: number;
  /** Add-on groups attached to THIS item. The set the POS should offer is the
   *  union of these and the item's category's — see resolveModifierGroups.
   *  Always an array. */
  modifier_group_ids: string[];
  /** @deprecated Speculative jsonb column, never populated. Superseded by the
   *  add-on catalog (ModifierGroup / MenuModifier). */
  modifiers: unknown;
  /** Optional preset annotations the waiter can tap to attach when adding
   *  this item ("low sugar", "extra hot"). Free-form notes still work. */
  preset_notes: string[];
};

// -------------------------------------------------------------------------
// Add-ons ("modifiers") — migration 0062.
//
// Add-ons are their OWN catalog, never menu items. Modelled as reusable groups
// attached to items and/or categories, the way Square/Toast/Lightspeed do it.
// -------------------------------------------------------------------------

/** One choice inside a group ("Extra cheese" +50). */
export type MenuModifier = {
  id: string;
  group_id: string;
  name: string;
  /** Zero is legal — a free choice like "No sugar". */
  price_cents: number;
  /** null = cost unset; contributes 0 to COGS, like MenuItem.cost_cents. */
  cost_cents?: number | null;
  sort: number;
  is_active: boolean;
};

/** A reusable set of add-on choices plus how many may be picked. */
export type ModifierGroup = {
  id: string;
  name: string;
  /** >= 1 makes the group REQUIRED: the POS must not add the line without a
   *  choice, and the API rejects it. */
  min_select: number;
  /** null / undefined = unlimited picks. */
  max_select?: number | null;
  sort: number;
  is_active: boolean;
  modifiers: MenuModifier[];
  /** How many items / categories this group is attached to, so the admin UI can
   *  show reuse and warn before a delete. */
  item_count: number;
  category_count: number;
};

/** Effective add-on groups for an item: the UNION of the item's own groups and
 *  its category's, in the order the catalog lists them.
 *
 *  Note this COMPOSES rather than overriding, unlike resolveKitchenBehavior and
 *  outlet resolution which pick a single winner. "All drinks get an extra shot"
 *  (category) and "this latte also gets syrup" (item) must both be offered.
 *  Mirrors effectiveModifierGroupIDs in apps/api/internal/api/modifiers.go. */
export function resolveModifierGroups(
  item: Pick<MenuItem, 'modifier_group_ids'> | undefined,
  category: Pick<MenuCategory, 'modifier_group_ids'> | undefined,
  groups: ModifierGroup[],
): ModifierGroup[] {
  const wanted = new Set([...(item?.modifier_group_ids ?? []), ...(category?.modifier_group_ids ?? [])]);
  if (wanted.size === 0) return [];
  // Filter the catalog rather than mapping the id set, so the result keeps the
  // catalog's sort order and silently drops ids whose group was deactivated.
  return groups.filter((g) => wanted.has(g.id) && g.is_active);
}

/** One chosen add-on on an order line, as the API returns it. Name and price are
 *  snapshots from when the line was added, so repricing never rewrites history. */
export type OrderItemAddOn = {
  id: string;
  modifier_id: string;
  group_name: string;
  name: string;
  price_cents: number;
  cost_cents: number;
  /** How many of this add-on on ONE unit of the parent (double cheese = 2). */
  qty: number;
};

/** One chosen add-on as the client SENDS it. `id` is client-minted so a replayed
 *  offline batch is idempotent, exactly like the parent line's id. */
export type AddOnChoice = {
  id?: string;
  modifier_id: string;
  qty?: number;
};

/** Stable key for a line's add-on set, used to decide whether tapping an item
 *  again should bump an existing pending line or start a new one. Two
 *  differently-topped sandwiches must NOT merge, so this has to be part of the
 *  stacking predicate alongside menu_item_id and notes. */
export function addOnKey(addOns: ReadonlyArray<Pick<OrderItemAddOn, 'modifier_id' | 'qty'>> | undefined): string {
  if (!addOns || addOns.length === 0) return '';
  return [...addOns]
    .map((a) => `${a.modifier_id}:${a.qty}`)
    .sort()
    .join('|');
}

/** Total add-on money on one unit of a line. Rounds per add-on then sums —
 *  matching resolveAddOns in Go and platform_accuracy_check_addons in SQL, so
 *  all three agree to the cent. */
export function addOnsUnitCents(
  addOns: ReadonlyArray<Pick<OrderItemAddOn, 'price_cents' | 'qty'>> | undefined,
): number {
  return (addOns ?? []).reduce((sum, a) => sum + Math.round((a.qty ?? 1) * a.price_cents), 0);
}

/** Tenant-wide default routing derived from the two preference toggles.
 *  Mirrors the server's derivation in SendOrderToKitchen. */
export function tenantDefaultKitchenBehavior(
  prefs: Pick<TenantPreferences, 'autoReadyOnSend' | 'autoServeOnReady'> | undefined,
): 'cook' | 'ready' | 'serve' {
  // autoServeOnReady defaults true server-side (COALESCE), so treat an unset
  // value as true here to keep the FE preview in step with the backend.
  if (prefs?.autoReadyOnSend && (prefs?.autoServeOnReady ?? true)) return 'serve';
  if (prefs?.autoReadyOnSend) return 'ready';
  return 'cook';
}

/** Effective kitchen routing for an order line: item override → category
 *  default → tenant default. Mirrors the server-side resolution. */
export function resolveKitchenBehavior(
  item: Pick<MenuItem, 'kitchen_behavior'> | undefined,
  category: Pick<MenuCategory, 'kitchen_behavior'> | undefined,
  prefs: Pick<TenantPreferences, 'autoReadyOnSend' | 'autoServeOnReady'> | undefined,
): 'cook' | 'ready' | 'serve' {
  const own = (b: KitchenBehavior | undefined) => (b && b !== 'inherit' ? b : undefined);
  return own(item?.kitchen_behavior) ?? own(category?.kitchen_behavior) ?? tenantDefaultKitchenBehavior(prefs);
}

export type BulkImportCounts = { created: number; updated: number; skipped: number };

export type BulkImportResult = { dry_run: boolean; categories: BulkImportCounts; items: BulkImportCounts };

export type BulkImportPayload = {
  /** When true the server matches + validates but writes nothing, returning
   *  the same counts — used to preview an import without committing it. */
  dry_run?: boolean;
  /** When a name already exists: true (default) updates it, false leaves it. */
  overwrite_existing?: boolean;
  categories: Array<{
    name: string;
    icon?: string;
    color?: string | null;
    items: Array<{
      name: string;
      description?: string;
      icon?: string;
      price_cents: number;
      cost_cents?: number | null;
    }>;
  }>;
};

export type PopularMenuItem = MenuItem & { qty_30d: number };

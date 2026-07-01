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
  /** Live count of non-deleted menu items in this category. */
  item_count: number;
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
  sort: number;
  modifiers: unknown;
  /** Optional preset annotations the waiter can tap to attach when adding
   *  this item ("low sugar", "extra hot"). Free-form notes still work. */
  preset_notes: string[];
};

/** Tenant-wide default routing derived from the two preference toggles.
 *  Mirrors the server's derivation in SendOrderToKitchen. */
export function tenantDefaultKitchenBehavior(
  prefs: Pick<TenantPreferences, 'autoReadyOnSend' | 'autoServeOnReady'> | undefined,
): 'cook' | 'ready' | 'serve' {
  if (prefs?.autoReadyOnSend && prefs?.autoServeOnReady) return 'serve';
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

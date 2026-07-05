// Outlets — prep destinations (Kitchen, Bar, Bar2, …) and their printers.
import type { PrintWidth } from './tenant';
import type { MenuCategory, MenuItem } from './menu';

/** A prep station with its own KDS board and a single networked printer.
 *  Categories (and, as an override, items) route to an outlet; the effective
 *  outlet resolves item → category → the tenant's default outlet. */
export type Outlet = {
  id: string;
  name: string;
  sort: number;
  is_active: boolean;
  /** Exactly one outlet per tenant is the default (the seeded "Kitchen"); it
   *  is the routing fallback and cannot be deleted. */
  is_default: boolean;
  /** The outlet's single ESC/POS network printer. null = none configured.
   *  Mobile prints straight to it; the browser window.print() path can't
   *  target an IP, so on web it's informational. */
  printer_ip?: string | null;
  printer_port: number;
  printer_width: PrintWidth;
};

/** Effective outlet id for an order line: item override → category → the
 *  tenant's default outlet. Mirrors the server-side resolution in
 *  SendOrderToKitchen. Returns undefined only when no outlets exist at all. */
export function resolveOutletId(
  item: Pick<MenuItem, 'outlet_id'> | undefined,
  category: Pick<MenuCategory, 'outlet_id'> | undefined,
  outlets: Outlet[] | undefined,
): string | undefined {
  const fallback = outlets?.find((o) => o.is_default)?.id;
  return item?.outlet_id ?? category?.outlet_id ?? fallback ?? undefined;
}

/** Like resolveOutletId but returns the whole Outlet (name + printer), which
 *  the print/grouping paths need. */
export function resolveOutlet(
  item: Pick<MenuItem, 'outlet_id'> | undefined,
  category: Pick<MenuCategory, 'outlet_id'> | undefined,
  outlets: Outlet[] | undefined,
): Outlet | undefined {
  const id = resolveOutletId(item, category, outlets);
  return outlets?.find((o) => o.id === id);
}

/**
 * What "Inherit" resolves to, and what a price and cost imply. These are the
 * labels that stop an operator having to hold the whole cascade in their head.
 */
import type { MenuCategory, Outlet } from '@cafe-mgmt/api-types';
import {
  behaviorLabel,
  inheritedBehaviorLabel,
  resolveOutlet,
  defaultOutlet,
  outletLabel,
  itemMargin,
  matchesQuery,
} from '../menuResolve';

const cat = (over: Partial<MenuCategory> = {}): MenuCategory =>
  ({
    id: 'c1',
    name: 'Drinks',
    sort: 0,
    icon: '',
    is_active: true,
    kitchen_behavior: 'inherit',
    item_count: 0,
    modifier_group_ids: [],
    ...over,
  }) as MenuCategory;

const outlet = (over: Partial<Outlet> = {}): Outlet =>
  ({
    id: 'o1',
    name: 'Kitchen',
    sort: 0,
    is_active: true,
    is_default: true,
    printer_port: 9100,
    printer_width: '80',
    ...over,
  }) as Outlet;

describe('behaviorLabel', () => {
  it('names each explicit routing in terms of what happens', () => {
    expect(behaviorLabel('cook')).toBe('Send to kitchen');
    expect(behaviorLabel('ready')).toBe('Mark ready on send');
    expect(behaviorLabel('serve')).toBe('Serve immediately');
    expect(behaviorLabel('inherit')).toBe('Inherit');
  });

  it('shows an unknown routing as-is rather than blanking the option', () => {
    // The union can go stale against a server that adds a behaviour.
    expect(behaviorLabel('flambe' as never)).toBe('flambe');
  });
});

describe('inheritedBehaviorLabel', () => {
  it("names the category's own setting, so Inherit is not a blank cheque", () => {
    expect(inheritedBehaviorLabel(cat({ kitchen_behavior: 'serve' }))).toBe(
      'Inherit from category (Serve immediately)',
    );
  });

  it('stays generic when the category itself inherits', () => {
    // Quoting the tenant default here would go stale the moment it changed.
    expect(inheritedBehaviorLabel(cat({ kitchen_behavior: 'inherit' }))).toBe('Inherit from category');
    expect(inheritedBehaviorLabel(undefined)).toBe('Inherit from category');
  });
});

describe('resolveOutlet', () => {
  const kitchen = outlet({ id: 'o1', name: 'Kitchen', is_default: true });
  const bar = outlet({ id: 'o2', name: 'Bar', is_default: false });

  it("uses the category's outlet when it has one", () => {
    expect(resolveOutlet(cat({ outlet_id: 'o2' }), [kitchen, bar])?.name).toBe('Bar');
  });

  it('falls back to the tenant default', () => {
    expect(resolveOutlet(cat(), [kitchen, bar])?.name).toBe('Kitchen');
    expect(defaultOutlet([kitchen, bar])?.name).toBe('Kitchen');
    expect(defaultOutlet(undefined)).toBeUndefined();
  });

  it('still resolves to an outlet that has been turned OFF', () => {
    // Mirrors the server: COALESCE(item, category, default) has no is_active
    // check, so pretending the routing falls back would be a lie — the
    // tickets really do go to the dark board.
    const off = { ...bar, is_active: false };
    expect(resolveOutlet(cat({ outlet_id: 'o2' }), [kitchen, off])?.name).toBe('Bar');
  });

  it('is undefined when there are no outlets at all', () => {
    expect(resolveOutlet(cat(), [])).toBeUndefined();
    expect(resolveOutlet(cat(), undefined)).toBeUndefined();
  });
});

describe('outletLabel', () => {
  it('says plainly when the resolved station is switched off', () => {
    expect(outletLabel(outlet({ name: 'Bar', is_active: true }))).toBe('Bar');
    expect(outletLabel(outlet({ name: 'Bar', is_active: false }))).toBe('Bar — turned off');
    expect(outletLabel(undefined)).toBeUndefined();
  });
});

describe('itemMargin', () => {
  it('reports the percentage and the rupees per sale', () => {
    expect(itemMargin(20000, 5000)).toEqual({ pct: 75, perSaleCents: 15000 });
  });

  it('rounds the percentage to whole points', () => {
    expect(itemMargin(30000, 10000)?.pct).toBe(67);
  });

  it('is null when either side is unknown — not zero', () => {
    // A margin against a zero price is a division, not a fact.
    expect(itemMargin(0, 5000)).toBeNull();
    expect(itemMargin(20000, 0)).toBeNull();
  });

  it('reports a LOSS rather than hiding it', () => {
    // An item priced under cost is exactly what this hint exists to catch.
    expect(itemMargin(5000, 8000)).toEqual({ pct: -60, perSaleCents: -3000 });
  });
});

describe('matchesQuery', () => {
  const item = { name: 'Jhol Momo', sku: 'MO-01', description: 'Steamed, in broth' };

  it('matches anywhere in the name, not just the start', () => {
    expect(matchesQuery(item, 'momo')).toBe(true);
    expect(matchesQuery(item, 'MOMO')).toBe(true);
  });

  it('matches the SKU and the description too', () => {
    expect(matchesQuery(item, 'mo-01')).toBe(true);
    expect(matchesQuery(item, 'broth')).toBe(true);
  });

  it('matches everything when nothing is typed', () => {
    expect(matchesQuery(item, '')).toBe(true);
    expect(matchesQuery(item, '   ')).toBe(true);
  });

  it('does not match an unrelated query', () => {
    expect(matchesQuery(item, 'latte')).toBe(false);
  });

  it('survives an item with no SKU or description', () => {
    expect(matchesQuery({ name: 'Tea' }, 'tea')).toBe(true);
    expect(matchesQuery({ name: 'Tea', sku: null }, 'zzz')).toBe(false);
  });
});

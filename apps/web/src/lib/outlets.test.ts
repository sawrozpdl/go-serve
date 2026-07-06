import { describe, it, expect } from 'vitest';
import { resolveOutletId, resolveOutlet, type Outlet, type MenuItem, type MenuCategory } from '@cafe-mgmt/api-types';

const outlet = (over: Partial<Outlet>): Outlet => ({
  id: over.id ?? 'o1',
  name: over.name ?? 'Kitchen',
  sort: over.sort ?? 0,
  is_active: over.is_active ?? true,
  is_default: over.is_default ?? false,
  printer_ip: over.printer_ip,
  printer_port: over.printer_port ?? 9100,
  printer_width: over.printer_width ?? '80',
});

const kitchen = outlet({ id: 'ok', name: 'Kitchen', is_default: true });
const bar = outlet({ id: 'ob', name: 'Bar' });
const outlets = [kitchen, bar];

const item = (outlet_id?: string | null): Pick<MenuItem, 'outlet_id'> => ({ outlet_id });
const cat = (outlet_id?: string | null): Pick<MenuCategory, 'outlet_id'> => ({ outlet_id });

describe('resolveOutletId', () => {
  it('prefers the item override', () => {
    expect(resolveOutletId(item('ob'), cat('ok'), outlets)).toBe('ob');
  });

  it('falls back to the category when the item has none', () => {
    expect(resolveOutletId(item(null), cat('ob'), outlets)).toBe('ob');
    expect(resolveOutletId(item(undefined), cat('ob'), outlets)).toBe('ob');
  });

  it('falls back to the default outlet when neither is set', () => {
    expect(resolveOutletId(item(null), cat(null), outlets)).toBe('ok');
  });

  it('is undefined when no outlets exist at all', () => {
    expect(resolveOutletId(item(null), cat(null), [])).toBeUndefined();
    expect(resolveOutletId(item(null), cat(null), undefined)).toBeUndefined();
  });

  it('handles missing item/category (unknown menu line)', () => {
    expect(resolveOutletId(undefined, undefined, outlets)).toBe('ok'); // default
  });
});

describe('resolveOutlet', () => {
  it('returns the whole outlet (with printer) for the resolved id', () => {
    expect(resolveOutlet(item('ob'), cat(null), outlets)).toEqual(bar);
    expect(resolveOutlet(item(null), cat(null), outlets)).toEqual(kitchen);
  });

  it('returns undefined when the resolved id has no matching outlet', () => {
    // item points at an outlet that no longer exists → no match
    expect(resolveOutlet(item('gone'), cat(null), outlets)).toBeUndefined();
  });

  it('returns undefined when there are no outlets', () => {
    expect(resolveOutlet(item(null), cat(null), [])).toBeUndefined();
  });
});

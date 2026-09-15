import { describe, it, expect } from 'vitest';

import { searchMenuItems } from './menuSearch';
import type { MenuItem } from '@/lib/api';

function item(name: string, category_id?: string): MenuItem {
  return { id: name, name, category_id, price_cents: 0 } as unknown as MenuItem;
}

const CATS = [
  { id: 'c1', name: 'Coffee' },
  { id: 'c2', name: 'Momo' },
];

describe('searchMenuItems', () => {
  it('finds items across every category, not just one', () => {
    // The whole point: these two live in different categories and both match.
    const items = [item('Mocha', 'c1'), item('Veg Momo', 'c2')];
    const hits = searchMenuItems(items, CATS, 'mo');
    expect(hits.map((h) => h.item.name).sort()).toEqual(['Mocha', 'Veg Momo']);
  });

  it('names the category on every hit, since results are cross-category', () => {
    const hits = searchMenuItems([item('Mocha', 'c1')], CATS, 'mocha');
    expect(hits[0]!.categoryName).toBe('Coffee');
  });

  it('labels an item whose category is unknown rather than showing blank', () => {
    const hits = searchMenuItems([item('Mystery', 'gone')], CATS, 'my');
    expect(hits[0]!.categoryName).toBe('Uncategorised');
  });

  it('labels an item with no category at all', () => {
    const hits = searchMenuItems([item('Loose')], CATS, 'loo');
    expect(hits[0]!.categoryName).toBe('Uncategorised');
  });

  it('treats regex metacharacters as literal text', () => {
    // "Cafe+Mocha (2-shot)" is an invalid RegExp; "(" would throw and "+" would
    // silently mis-match. This is why the implementation uses includes().
    const items = [item('Cafe+Mocha (2-shot)', 'c1')];
    expect(searchMenuItems(items, CATS, '+moc')).toHaveLength(1);
    expect(searchMenuItems(items, CATS, '(2-shot)')).toHaveLength(1);
    expect(searchMenuItems(items, CATS, 'e+m')).toHaveLength(1);
  });

  it('does not let a metacharacter query match everything', () => {
    const items = [item('Tea', 'c1'), item('Coffee', 'c1')];
    expect(searchMenuItems(items, CATS, '.*')).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    expect(searchMenuItems([item('MOMO', 'c2')], CATS, 'momo')).toHaveLength(1);
    expect(searchMenuItems([item('momo', 'c2')], CATS, 'MOMO')).toHaveLength(1);
  });

  it('ranks prefix matches above interior ones', () => {
    const items = [item('Lemon Mojito', 'c1'), item('Momo', 'c2')];
    const hits = searchMenuItems(items, CATS, 'mo');
    expect(hits[0]!.item.name).toBe('Momo');
  });

  it('falls back to alphabetical within the same rank', () => {
    const items = [item('Momo Jhol', 'c2'), item('Momo Chilli', 'c2')];
    const hits = searchMenuItems(items, CATS, 'momo');
    expect(hits.map((h) => h.item.name)).toEqual(['Momo Chilli', 'Momo Jhol']);
  });

  it('ignores surrounding whitespace', () => {
    expect(searchMenuItems([item('Momo', 'c2')], CATS, '  momo  ')).toHaveLength(1);
  });

  it('returns nothing for an empty or whitespace query', () => {
    const items = [item('Momo', 'c2')];
    expect(searchMenuItems(items, CATS, '')).toEqual([]);
    expect(searchMenuItems(items, CATS, '   ')).toEqual([]);
  });
});

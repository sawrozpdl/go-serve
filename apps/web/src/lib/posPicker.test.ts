import { describe, it, expect } from 'vitest';

import { posPickerLayout, pickPosItems } from './posPicker';
import type { MenuItem } from '@/lib/api';

function item(name: string, category_id?: string): MenuItem {
  return { id: name, name, category_id } as unknown as MenuItem;
}

const ITEMS = [item('Momo', 'c1'), item('Mocha', 'c2'), item('Tea', 'c2')];
const POPULAR = [item('Momo', 'c1')];

describe('posPickerLayout', () => {
  it('defaults to both when unset, so an unset preference changes nothing', () => {
    expect(posPickerLayout(undefined)).toEqual({ showSearch: true, showChips: true });
  });

  it('maps each explicit mode', () => {
    expect(posPickerLayout('search')).toEqual({ showSearch: true, showChips: false });
    expect(posPickerLayout('categories')).toEqual({ showSearch: false, showChips: true });
    expect(posPickerLayout('both')).toEqual({ showSearch: true, showChips: true });
  });
});

describe('pickPosItems', () => {
  it('lets a search override the active category', () => {
    const got = pickPosItems({
      mode: 'both',
      search: 'mo',
      activeCat: 'c1',
      items: ITEMS,
      popular: POPULAR,
    });
    expect(got.map((i) => i.name)).toEqual(['Momo', 'Mocha']);
  });

  it('filters by the active category when there is no search', () => {
    const got = pickPosItems({
      mode: 'both',
      search: '',
      activeCat: 'c2',
      items: ITEMS,
      popular: POPULAR,
    });
    expect(got.map((i) => i.name)).toEqual(['Mocha', 'Tea']);
  });

  it('serves the popular list for the __popular__ pseudo-category', () => {
    const got = pickPosItems({
      mode: 'both',
      search: '',
      activeCat: '__popular__',
      items: ITEMS,
      popular: POPULAR,
    });
    expect(got).toEqual(POPULAR);
  });

  it('ignores a stale category when the chips are hidden', () => {
    // Otherwise switching to "search only" strands the grid on whatever
    // category happened to be active, with no chip left to change it.
    const got = pickPosItems({
      mode: 'search',
      search: '',
      activeCat: 'c1',
      items: ITEMS,
      popular: POPULAR,
    });
    expect(got).toHaveLength(3);
  });

  it('ignores a stale search term when the search box is hidden', () => {
    // Otherwise switching to "categories only" leaves an invisible filter
    // hiding most of the menu, with no input left to clear it.
    const got = pickPosItems({
      mode: 'categories',
      search: 'zzz',
      activeCat: null,
      items: ITEMS,
      popular: POPULAR,
    });
    expect(got).toHaveLength(3);
  });

  it('still honours the category in categories-only mode', () => {
    const got = pickPosItems({
      mode: 'categories',
      search: 'zzz',
      activeCat: 'c1',
      items: ITEMS,
      popular: POPULAR,
    });
    expect(got.map((i) => i.name)).toEqual(['Momo']);
  });

  it('treats metacharacters literally', () => {
    const items = [item('Cafe+Mocha (2-shot)', 'c1'), item('Tea', 'c2')];
    expect(pickPosItems({ mode: 'both', search: '+moc', activeCat: null, items, popular: [] }))
      .toHaveLength(1);
    expect(pickPosItems({ mode: 'both', search: '.*', activeCat: null, items, popular: [] }))
      .toHaveLength(0);
  });

  it('shows everything with no search and no category', () => {
    const got = pickPosItems({
      mode: 'both',
      search: '   ',
      activeCat: null,
      items: ITEMS,
      popular: POPULAR,
    });
    expect(got).toHaveLength(3);
  });
});

// Searching the menu catalog.
//
// The admin Menu page filtered `useMenuItems(selectedCatId)` — the items of the
// ONE category highlighted in the left rail. So searching for an item whose
// category you had not already selected returned "No items match", which is the
// same answer the page gives for an item that does not exist. The one question
// a catalog search exists to answer — "do we sell this, and where did we put
// it?" — was the question it could not answer.
//
// The POS order screen has always searched the whole menu (TabPage), for the
// stated reason that a cashier who knows an item's name does not know which
// category it lives in. That is at least as true of the owner editing the menu,
// who is usually there precisely because they have lost something.

import type { MenuItem } from '@/lib/api';

export type MenuSearchHit = {
  item: MenuItem;
  categoryId: string | null;
  /** Always a printable label — the results are cross-category, so every row
   *  has to say where it came from or the list is ambiguous. */
  categoryName: string;
};

type CategoryLike = { id: string; name: string };

/**
 * Cross-category menu search, ranked.
 *
 * Plain `String.includes` on a lowercased needle, NEVER a RegExp: a real menu
 * contains names like "Cafe+Mocha (2-shot)" and "Momo (10pc)", which are
 * invalid patterns or — worse — valid ones that silently match the wrong rows.
 * The POS carries the same warning in a comment; this is the shared
 * implementation of it.
 *
 * Ranking puts prefix matches above interior ones, then falls back to
 * alphabetical. Typing "mo" should offer Momo before Lemon Mojito: the thing
 * you started spelling is the thing you meant.
 */
export function searchMenuItems(
  items: readonly MenuItem[],
  categories: readonly CategoryLike[],
  query: string,
): MenuSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const nameById = new Map(categories.map((c) => [c.id, c.name]));

  const scored: { hit: MenuSearchHit; prefix: boolean; name: string }[] = [];
  for (const item of items) {
    const name = item.name.toLowerCase();
    const at = name.indexOf(needle);
    if (at < 0) continue;
    scored.push({
      hit: {
        item,
        categoryId: item.category_id ?? null,
        categoryName:
          (item.category_id ? nameById.get(item.category_id) : undefined) ?? 'Uncategorised',
      },
      prefix: at === 0,
      name,
    });
  }

  scored.sort((a, b) => {
    if (a.prefix !== b.prefix) return a.prefix ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return scored.map((s) => s.hit);
}

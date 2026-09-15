// Which item-finding controls the POS shows, and what the grid contains.
//
// Cafes differ in a way one layout cannot serve. A cafe with 200 items across
// 18 categories wants the search box — its staff know the names and the chip
// strip is two scrolling rows of noise. A cafe with 30 items across 4
// categories wants the chips — its whole menu is two taps away and the search
// box is a keyboard nobody asked for on a tablet. Showing both costs the
// smaller cafe vertical space above the grid on the screen they use all day.
//
// The filtering rule itself is unchanged from what the POS has always done: a
// search overrides the active category chip and looks across the whole menu,
// because a cashier who knows an item's name does not know which category it
// lives in.

import type { MenuItem } from '@/lib/api';

export type PosPickerMode = 'search' | 'categories' | 'both';

export type PosPickerLayout = { showSearch: boolean; showChips: boolean };

/** Default is 'both' — the behaviour every workspace had before the setting
 *  existed, so an unset preference changes nothing. */
export function posPickerLayout(mode: PosPickerMode | undefined): PosPickerLayout {
  switch (mode) {
    case 'search':
      return { showSearch: true, showChips: false };
    case 'categories':
      return { showSearch: false, showChips: true };
    default:
      return { showSearch: true, showChips: true };
  }
}

export type PickPosItemsArgs = {
  mode: PosPickerMode | undefined;
  search: string;
  activeCat: string | null;
  items: readonly MenuItem[];
  popular: readonly MenuItem[];
};

/**
 * The items the POS grid should show.
 *
 * Both hidden controls are actively IGNORED rather than merely not rendered.
 * A control the operator cannot see is a filter they cannot clear: a stale
 * search term left over from before the preference changed would hide the grid
 * with no visible cause, and a stale category would strand it on one section
 * with no way to leave. Computed here rather than reset by an effect, so there
 * is no render where the wrong thing is on screen.
 */
export function pickPosItems(args: PickPosItemsArgs): MenuItem[] {
  const { showSearch, showChips } = posPickerLayout(args.mode);

  // Plain includes, never a RegExp: a name like "Cafe+Mocha (2-shot)" would be
  // an invalid pattern, and metacharacters would silently mis-match.
  const term = showSearch ? args.search.trim().toLowerCase() : '';
  if (term) {
    return args.items.filter((i) => i.name.toLowerCase().includes(term));
  }

  if (!showChips) return [...args.items];

  const cat = args.activeCat;
  if (cat === '__popular__') return [...args.popular];
  if (cat) return args.items.filter((i) => i.category_id === cat);
  return [...args.items];
}

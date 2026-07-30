/**
 * Which category the order menu is showing. This lives outside MenuGrid because
 * the add-items screen is a fresh `router.push` every time (and "Done" replaces
 * back to the ticket), so component state can't survive the menu → ticket →
 * menu round trip: the grid kept snapping back to "Popular" after each add,
 * losing the category the server was mid-order on.
 *
 * Session-scoped and deliberately not persisted — a category choice isn't meant
 * to outlive an app restart. `null` means "no choice yet, use the default";
 * MenuGrid validates the id against the live catalog before honouring it, so a
 * deleted category (or one from another tenant) falls back to the default.
 */
import { create } from 'zustand';

type MenuUiState = {
  /** The chosen category id, `__popular__` for the Popular pseudo-category, or
   *  null when the user hasn't picked one this session. */
  catId: string | null;
  setCatId: (catId: string) => void;
};

export const useMenuUi = create<MenuUiState>((set) => ({
  catId: null,
  setCatId: (catId) => set({ catId }),
}));

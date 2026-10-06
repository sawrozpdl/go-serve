/**
 * Draft cart — the in-progress order held ON THE DEVICE until it's first sent to
 * the kitchen. Nothing touches the server (no `POST /orders`) while a draft is
 * open, so the table stays free on the floor and backing out discards silently —
 * a mis-tapped order never leaves a tab to cancel. `doSend` in useOrderController
 * flips a draft into a real order (create → add items → send) and then clears it.
 *
 * Single active draft: one terminal builds one order at a time, so `startDraft`
 * (called from the floor's "open a free table" / "new walk-in" entry points)
 * resets any prior unsent draft. Ephemeral by design — not persisted; an unsent
 * cart is not meant to survive an app restart.
 */
import { create } from 'zustand';
import type { OrderItemRow } from '@cafe-mgmt/api-types';

type DraftCartState = {
  tableId: string | null;
  tableName: string | null;
  /** Free-text name for a walk-in draft ("Ram"), carried into the order at
   *  creation time — naming a tab before its first send must not be lost. */
  label: string;
  /** Set when the draft is the shared staff-meals tab — free food for the team,
   *  never attributed to a person (0085). Never combined with a table: a staff
   *  meal does not occupy one. */
  staffMeal: boolean;
  items: OrderItemRow[];
  /** Begin a fresh draft for a table (or walk-in when null), discarding any
   *  prior unsent draft. */
  startDraft: (tableId: string | null, tableName: string | null) => void;
  /** Begin a fresh staff-meal draft, discarding any prior unsent draft. */
  startStaffMealDraft: () => void;
  /** Replace the line list (pass an updater over the current items). */
  setItems: (updater: (items: OrderItemRow[]) => OrderItemRow[]) => void;
  /** Name (or clear the name of) the draft tab. */
  setLabel: (label: string) => void;
  /** Drop everything — after a successful send or an explicit cancel. */
  clear: () => void;
};

export const useDraftCart = create<DraftCartState>((set) => ({
  tableId: null,
  tableName: null,
  label: '',
  staffMeal: false,
  items: [],
  startDraft: (tableId, tableName) =>
    set({ tableId, tableName, label: '', staffMeal: false, items: [] }),
  // Matches the label OpenOrder writes, so the draft reads the same as the tab
  // it becomes.
  startStaffMealDraft: () =>
    set({ tableId: null, tableName: null, label: 'Staff meals', staffMeal: true, items: [] }),
  setItems: (updater) => set((s) => ({ items: updater(s.items) })),
  setLabel: (label) => set({ label }),
  clear: () =>
    set({ tableId: null, tableName: null, label: '', staffMeal: false, items: [] }),
}));

/** Non-React accessor for the floor entry points (outside the component tree). */
export const startDraft = (tableId: string | null, tableName: string | null): void =>
  useDraftCart.getState().startDraft(tableId, tableName);

export const startStaffMealDraft = (): void => useDraftCart.getState().startStaffMealDraft();

/**
 * Throw away whatever draft is open. Call it when navigating into an EXISTING
 * order: only the new-tab entry points reset this store, so an abandoned draft
 * used to follow the device into every other tab it opened — and a leftover
 * `staffMeal` flag made a paying tab offer "Finish" (close, no payment) instead of
 * "Settle", which the API then refused with the whole total outstanding.
 */
export const clearDraft = (): void => useDraftCart.getState().clear();

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
  items: OrderItemRow[];
  /** Begin a fresh draft for a table (or walk-in when null), discarding any
   *  prior unsent draft. */
  startDraft: (tableId: string | null, tableName: string | null) => void;
  /** Replace the line list (pass an updater over the current items). */
  setItems: (updater: (items: OrderItemRow[]) => OrderItemRow[]) => void;
  /** Drop everything — after a successful send or an explicit cancel. */
  clear: () => void;
};

export const useDraftCart = create<DraftCartState>((set) => ({
  tableId: null,
  tableName: null,
  items: [],
  startDraft: (tableId, tableName) => set({ tableId, tableName, items: [] }),
  setItems: (updater) => set((s) => ({ items: updater(s.items) })),
  clear: () => set({ tableId: null, tableName: null, items: [] }),
}));

/** Non-React accessor for the floor entry points (outside the component tree). */
export const startDraft = (tableId: string | null, tableName: string | null): void =>
  useDraftCart.getState().startDraft(tableId, tableName);

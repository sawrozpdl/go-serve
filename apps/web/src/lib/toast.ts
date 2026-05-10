/* Lightweight toast store.
 *
 * Action feedback bus. Mutations call `toast.success("Order sent")` and
 * the <Toasts/> container renders a stack in the lower-right.
 *
 * - One zustand store with id-keyed list
 * - Auto-dismiss timer per toast (defaults 3.2s)
 * - `kind`: success | info | error  → drives the icon + accent color
 */

import { create } from 'zustand';

export type ToastKind = 'success' | 'info' | 'error';

export type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
  hint?: string;
  /** ms — set 0 to keep open until manually dismissed */
  ttl: number;
};

type State = {
  items: Toast[];
  // eslint-disable-next-line no-unused-vars
  push: (_t: Omit<Toast, 'id'>) => number;
  // eslint-disable-next-line no-unused-vars
  dismiss: (_id: number) => void;
};

const useToastStore = create<State>((set) => ({
  items: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ items: [...s.items, { id, ...t }] }));
    if (t.ttl > 0) {
      setTimeout(() => {
        set((s) => ({ items: s.items.filter((x) => x.id !== id) }));
      }, t.ttl);
    }
    return id;
  },
  dismiss: (id) =>
    set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

export function useToasts() {
  return useToastStore((s) => s.items);
}

export function useDismissToast() {
  return useToastStore((s) => s.dismiss);
}

/** Imperative API: works outside React (e.g. in mutation onSuccess callbacks). */
export const toast = {
  success: (message: string, hint?: string) =>
    useToastStore.getState().push({ kind: 'success', message, hint, ttl: 3200 }),
  info: (message: string, hint?: string) =>
    useToastStore.getState().push({ kind: 'info', message, hint, ttl: 3200 }),
  error: (message: string, hint?: string) =>
    useToastStore.getState().push({ kind: 'error', message, hint, ttl: 5000 }),
};

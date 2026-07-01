/**
 * Tiny toast system: a Zustand store of transient messages + non-React
 * `toast.success/error/info` accessors for use outside components. The `Toasts`
 * host component renders + auto-dismisses them.
 */
import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info';
export type ToastItem = { id: string; kind: ToastKind; title: string; msg?: string };

type ToastState = {
  items: ToastItem[];
  push: (t: Omit<ToastItem, 'id'>) => void;
  dismiss: (id: string) => void;
};

let seq = 0;

export const useToasts = create<ToastState>((set) => ({
  items: [],
  push: (t) => {
    const id = `t${++seq}`;
    set((s) => ({ items: [...s.items, { ...t, id }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((x) => x.id !== id) })), 3500);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

function show(kind: ToastKind, title: string, msg?: string) {
  useToasts.getState().push({ kind, title, msg });
}

export const toast = {
  success: (title: string, msg?: string) => show('success', title, msg),
  error: (title: string, msg?: string) => show('error', title, msg),
  info: (title: string, msg?: string) => show('info', title, msg),
};

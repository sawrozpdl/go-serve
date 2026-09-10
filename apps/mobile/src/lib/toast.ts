/**
 * Tiny toast system: a Zustand store of transient messages + non-React
 * `toast.success/error/info` accessors for use outside components. The `Toasts`
 * host component renders + auto-dismisses them.
 */
import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info';

/**
 * An optional single action, which is what makes Undo possible.
 *
 * Undo is not a nicety on a POS: the alternative to a five-second window is a
 * confirm dialog on every destructive tap, and a confirm on a tap you make
 * forty times a service is worse than the mistake it prevents. The action
 * dismisses the toast when fired — it can only be taken once.
 */
export type ToastAction = { label: string; onPress: () => void };

export type ToastItem = {
  id: string;
  kind: ToastKind;
  title: string;
  msg?: string;
  action?: ToastAction;
};

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
    // An actionable toast lingers: 3.5s is enough to read "Deleted", not
    // enough to notice it was wrong and reach for Undo.
    setTimeout(
      () => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
      t.action ? 7000 : 3500,
    );
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

function show(kind: ToastKind, title: string, msg?: string, action?: ToastAction) {
  useToasts.getState().push({ kind, title, msg, action });
}

export const toast = {
  success: (title: string, msg?: string) => show('success', title, msg),
  error: (title: string, msg?: string) => show('error', title, msg),
  info: (title: string, msg?: string) => show('info', title, msg),
  /**
   * A success with a way back. `onUndo` runs at most once — the toast
   * dismisses itself the moment it is taken, so a double tap cannot re-add
   * a line or re-record a payment.
   */
  undo: (title: string, onUndo: () => void, msg?: string) =>
    show('success', title, msg, { label: 'Undo', onPress: onUndo }),
};

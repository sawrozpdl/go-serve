/**
 * Which credit account to open, and in which branch (multi-branch).
 *
 * Opening another branch's account switches branch first, and a branch switch
 * remounts the More stack (/me reloads for the new branch, so the tab bar
 * briefly drops permission-gated tabs). Screen state and route params don't
 * survive that, so the request lives here, keyed by branch: the Credit screen
 * opens it only once the active branch IS that branch — never asking the new
 * branch for the old one's account.
 */
import { create } from 'zustand';

type Pending = { id: string; slug: string } | null;

type CreditOpenState = {
  pending: Pending;
  open: (id: string, slug: string) => void;
  clear: () => void;
};

export const useCreditOpen = create<CreditOpenState>()((set) => ({
  pending: null,
  open: (id, slug) => set({ pending: { id, slug } }),
  clear: () => set({ pending: null }),
}));

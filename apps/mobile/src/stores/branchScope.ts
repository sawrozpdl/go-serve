/**
 * "All branches" on the dashboard (multi-branch, 0088). Persisted so an owner
 * who watches the whole business reopens onto it; picking a single branch
 * turns it off. Mirrors web's cafe-branch-scope.
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { mmkvStorage } from '../lib/zustandStorage';

type ScopeState = { all: boolean; setAll: (all: boolean) => void };

export const useBranchScope = create<ScopeState>()(
  persist((set) => ({ all: false, setAll: (all) => set({ all }) }), {
    name: 'goserve-branch-scope',
    storage: createJSONStorage(() => mmkvStorage),
  }),
);

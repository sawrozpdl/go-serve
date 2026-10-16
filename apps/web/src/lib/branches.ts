/* Multi-branch helpers (migration 0088).
 *
 * A branch is an ordinary café (tenant) that belongs to a business. Switching
 * branch is switching the active tenant slug — every query key already carries
 * the slug, so each branch's cache stays its own.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Branch, Me } from '@cafe-mgmt/api-types';

import { CHART_PALETTE } from './chartColors';

/** The branch's own name with the business name stripped off the front, so a
 *  "Sahan Cafe Thamel" branch of "Sahan Cafe" reads as "Thamel" under the
 *  business heading. Falls back to the full name when stripping leaves nothing. */
export function branchLabel(name: string, businessName?: string | null): string {
  const full = name.trim();
  if (!businessName) return full;
  const biz = businessName.trim();
  if (biz && full.toLowerCase().startsWith(biz.toLowerCase())) {
    const rest = full.slice(biz.length).replace(/^[\s\-–—·|,:/()]+/, '').replace(/\)\s*$/, '').trim();
    if (rest) return rest;
  }
  return full;
}

/** A stable colour per branch, drawn from the chart palette so the same branch
 *  is the same colour in the switcher, the comparison table and stacked charts.
 *  Assigned by slug order — distinct for up to eight branches. */
export function branchColor(branches: Pick<Branch, 'slug'>[], slug: string): string {
  const order = branches.map((b) => b.slug).sort();
  const idx = Math.max(0, order.indexOf(slug));
  return CHART_PALETTE[idx % CHART_PALETTE.length] ?? CHART_PALETTE[0];
}

/** True when the user has more than one branch to move between — the only
 *  time branch UI appears. A standalone café, or a waiter who works at one
 *  branch, sees exactly what they always have. */
export function hasBranches(me: Me | undefined): boolean {
  return !!me?.business && (me.branches?.length ?? 0) > 1;
}

const ID_SEGMENT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|new)$/i;

/** Where to land after switching branch: the same page, minus anything that
 *  names a row in the OLD branch (an order id, a staff id). The query string is
 *  kept, so "Dashboard · last 7 days" in Thamel becomes the same view in
 *  Lakeside — comparing two branches on one date is a single click. */
export function switchTarget(pathname: string, search: string): string {
  const segs = pathname.split('/').filter(Boolean);
  if (segs[0] !== 'admin') return '/admin';
  const kept: string[] = [];
  for (const s of segs) {
    if (ID_SEGMENT.test(s)) break;
    kept.push(s);
  }
  return '/' + kept.join('/') + (search ?? '');
}

/** Whole-number percentages of `values` that always add up to exactly 100
 *  (largest remainder), so a "% of sales" column never totals 99 or 101. */
export function sharePercents(values: number[]): number[] {
  const total = values.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (Math.max(0, v) / total) * 100);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left--;
  }
  return floors;
}

/** Overview mode ("All branches"). Remembered per browser, so an owner who
 *  watches the whole business lands back on it; picking any single branch
 *  turns it off. Only takes effect when the user really has ≥2 branches. */
type ScopeState = { all: boolean; setAll: (all: boolean) => void };
export const useBranchScopeStore = create<ScopeState>()(
  persist((set) => ({ all: false, setAll: (all) => set({ all }) }), { name: 'cafe-branch-scope' }),
);

/** Routes that can show all branches at once. Everything else works on one
 *  branch and asks which, rather than silently showing the anchor branch. */
export function isOverviewRoute(pathname: string): boolean {
  return pathname === '/admin' || pathname === '/admin/';
}

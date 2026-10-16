/**
 * Multi-branch helpers (migration 0088), mirroring web's lib/branches.ts. A
 * branch is an ordinary workspace that belongs to a business; switching branch
 * is switching the active tenant.
 */
import type { Branch, Me } from '@cafe-mgmt/api-types';

/** Web's categorical chart palette (lib/chartColors.ts) — the same branch is
 *  the same colour on the phone and on the web dashboard. */
const BRANCH_PALETTE = ['#FFA319', '#A3F02C', '#7DD3FC', '#F472B6', '#C084FC', '#34D399', '#FB7185', '#94A3B8'] as const;

/** "Sahan Cafe Thamel" under "Sahan Cafe" reads as "Thamel". */
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

/** Stable colour per branch, assigned by slug order. */
export function branchColor(branches: Pick<Branch, 'slug'>[], slug: string): string {
  const order = branches.map((b) => b.slug).sort();
  const idx = Math.max(0, order.indexOf(slug));
  return BRANCH_PALETTE[idx % BRANCH_PALETTE.length] ?? BRANCH_PALETTE[0];
}

/** True when the user has more than one branch to move between. */
export function hasBranches(me: Me | null | undefined): boolean {
  return !!me?.business && (me.branches?.length ?? 0) > 1;
}

/** Whole-number percentages that always add up to exactly 100. */
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

/* Multi-branch helpers (migration 0088).
 *
 * A branch is an ordinary café (tenant) that belongs to a business. Switching
 * branch is switching the active tenant slug — every query key already carries
 * the slug, so each branch's cache stays its own.
 */

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

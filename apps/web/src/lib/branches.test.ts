import { describe, expect, it } from 'vitest';

import { branchColor, branchLabel, hasBranches, isOverviewRoute, sharePercents, switchTarget } from './branches';
import { CHART_PALETTE } from './chartColors';

describe('branchLabel', () => {
  it('strips the business name off the front', () => {
    expect(branchLabel('Sahan Cafe Thamel', 'Sahan Cafe')).toBe('Thamel');
    expect(branchLabel('Sahan Cafe — Lakeside', 'Sahan Cafe')).toBe('Lakeside');
    expect(branchLabel('Sahan Cafe (Jhamsikhel)', 'sahan cafe')).toBe('Jhamsikhel');
  });
  it('keeps the full name when nothing would be left, or nothing matches', () => {
    expect(branchLabel('Sahan Cafe', 'Sahan Cafe')).toBe('Sahan Cafe');
    expect(branchLabel('Thamel Corner', 'Sahan Cafe')).toBe('Thamel Corner');
    expect(branchLabel('Thamel Corner', null)).toBe('Thamel Corner');
  });
});

describe('branchColor', () => {
  const branches = [{ slug: 'sahan-thamel' }, { slug: 'sahan' }, { slug: 'sahan-lakeside' }];
  it('is distinct per branch and independent of list order', () => {
    const colours = branches.map((b) => branchColor(branches, b.slug));
    expect(new Set(colours).size).toBe(3);
    expect(branchColor([...branches].reverse(), 'sahan')).toBe(branchColor(branches, 'sahan'));
  });
  it('falls back to the first slot for an unknown slug', () => {
    expect(branchColor(branches, 'nope')).toBe(CHART_PALETTE[0]);
  });
});

describe('hasBranches', () => {
  const base = { user_id: 'u', email: 'e', name: 'n', memberships: [] };
  it('needs a business AND more than one branch', () => {
    expect(hasBranches(undefined)).toBe(false);
    expect(hasBranches(base)).toBe(false);
    const one = { tenant_id: 'a', slug: 'a', name: 'A', timezone: 'Asia/Kathmandu', roles: [], is_active: true };
    expect(hasBranches({ ...base, business: { id: 'b', name: 'B' }, branches: [one] })).toBe(false);
    expect(hasBranches({ ...base, business: { id: 'b', name: 'B' }, branches: [one, { ...one, slug: 'c', is_active: false }] })).toBe(true);
  });
});


describe('switchTarget', () => {
  it('keeps the page and its filters', () => {
    expect(switchTarget('/admin', '?range=7d')).toBe('/admin?range=7d');
    expect(switchTarget('/admin/reports/profitability', '?from=2026-10-01&to=2026-10-15')).toBe(
      '/admin/reports/profitability?from=2026-10-01&to=2026-10-15',
    );
  });
  it('drops anything that names a row in the old branch', () => {
    expect(switchTarget('/admin/floor/3fa85f64-5717-4562-b3fc-2c963f66afa6', '')).toBe('/admin/floor');
    expect(switchTarget('/admin/floor/new', '')).toBe('/admin/floor');
    expect(switchTarget('/admin/staff/3fa85f64-5717-4562-b3fc-2c963f66afa6/docs', '')).toBe('/admin/staff');
  });
  it('sends anything outside the admin app to the dashboard', () => {
    expect(switchTarget('/pick-workspace', '')).toBe('/admin');
  });
});

describe('sharePercents', () => {
  it('always sums to exactly 100', () => {
    for (const vals of [[1, 1, 1], [2, 2, 2, 3], [5000, 3333, 1667], [1, 0, 0], [7, 13, 80]]) {
      expect(sharePercents(vals).reduce((a, b) => a + b, 0)).toBe(100);
    }
    expect(sharePercents([1, 1, 1]).sort()).toEqual([33, 33, 34]);
  });
  it('is all zeros when there is nothing to share', () => {
    expect(sharePercents([0, 0])).toEqual([0, 0]);
    expect(sharePercents([])).toEqual([]);
  });
});

describe('isOverviewRoute', () => {
  it('is the dashboard and the reports that can combine branches', () => {
    expect(isOverviewRoute('/admin')).toBe(true);
    expect(isOverviewRoute('/admin/')).toBe(true);
    expect(isOverviewRoute('/admin/reports/profitability')).toBe(true);
    expect(isOverviewRoute('/admin/reports/movers/')).toBe(true);
    expect(isOverviewRoute('/admin/reports/builder')).toBe(false);
    expect(isOverviewRoute('/admin/floor')).toBe(false);
  });
});

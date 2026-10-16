import { branchColor, branchLabel, hasBranches, sharePercents } from '../branches';

describe('branchLabel', () => {
  it('strips the business name off the front', () => {
    expect(branchLabel('Sahan Cafe Thamel', 'Sahan Cafe')).toBe('Thamel');
    expect(branchLabel('Sahan Cafe — Lakeside', 'Sahan Cafe')).toBe('Lakeside');
  });
  it('keeps the full name when nothing is left or nothing matches', () => {
    expect(branchLabel('Sahan Cafe', 'Sahan Cafe')).toBe('Sahan Cafe');
    expect(branchLabel('Corner', 'Sahan Cafe')).toBe('Corner');
  });
});

describe('branchColor', () => {
  it('is distinct per branch and order-independent', () => {
    const bs = [{ slug: 'b' }, { slug: 'a' }, { slug: 'c' }];
    expect(new Set(bs.map((b) => branchColor(bs, b.slug))).size).toBe(3);
    expect(branchColor([...bs].reverse(), 'a')).toBe(branchColor(bs, 'a'));
  });
});

describe('hasBranches', () => {
  const base = { user_id: 'u', email: 'e', name: 'n', memberships: [] };
  const one = { tenant_id: 'a', slug: 'a', name: 'A', timezone: 'Asia/Kathmandu', roles: [], is_active: true };
  it('needs a business and two branches', () => {
    expect(hasBranches(base)).toBe(false);
    expect(hasBranches({ ...base, business: { id: 'b', name: 'B' }, branches: [one] })).toBe(false);
    expect(hasBranches({ ...base, business: { id: 'b', name: 'B' }, branches: [one, { ...one, slug: 'c' }] })).toBe(true);
  });
});

describe('sharePercents', () => {
  it('always sums to 100', () => {
    for (const v of [[1, 1, 1], [5000, 3333, 1667], [7, 13, 80]]) {
      expect(sharePercents(v).reduce((a, b) => a + b, 0)).toBe(100);
    }
    expect(sharePercents([0, 0])).toEqual([0, 0]);
  });
});

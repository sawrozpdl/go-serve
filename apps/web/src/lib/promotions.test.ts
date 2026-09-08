import { describe, expect, it } from 'vitest';
import {
  bpToPctText,
  isCategoryPromotion,
  pctToBp,
  promotionLabel,
  type OrderAdjustment,
} from '@cafe-mgmt/api-types';

const base: OrderAdjustment = {
  id: 'a1',
  order_id: 'o1',
  type: 'discount',
  amount_cents: 4500,
  reason: 'promotion',
  applied_by_user_id: 'u1',
  approved_by_user_id: 'u1',
  created_at: '2026-09-08T00:00:00Z',
};

describe('pctToBp', () => {
  it.each([
    ['10', 1000, 'a whole percent'],
    ['10.5', 1050, 'half a percent survives'],
    ['0', 0, 'zero means no promotion'],
    ['', 0, 'blank means no promotion'],
    ['abc', 0, 'junk means no promotion, never NaN into the payload'],
    ['-5', 0, 'a negative promotion is not a thing'],
    ['100', 10000, 'a full discount is allowed'],
    ['250', 10000, 'clamped to the ceiling the server also enforces'],
    ['10.004', 1000, 'rounds to the nearest basis point'],
  ])('%s → %i (%s)', (text, want) => {
    expect(pctToBp(text as string)).toBe(want);
  });

  it('round-trips through bpToPctText without trailing zeros', () => {
    for (const text of ['10', '10.5', '7.25', '100']) {
      expect(bpToPctText(pctToBp(text))).toBe(text);
    }
  });
});

describe('isCategoryPromotion', () => {
  it('is true only for a discount carrying a category', () => {
    expect(isCategoryPromotion({ ...base, menu_category_id: 'c1' })).toBe(true);
  });

  it('is false for a manual discount or a QR reward', () => {
    // Both are the same row shape on purpose, so the category id is the only
    // thing that separates them.
    expect(isCategoryPromotion(base)).toBe(false);
    expect(isCategoryPromotion({ ...base, menu_category_id: null })).toBe(false);
  });

  it('is false for a service charge even if a category somehow rode along', () => {
    expect(
      isCategoryPromotion({ ...base, type: 'service_charge', menu_category_id: 'c1' }),
    ).toBe(false);
  });
});

describe('promotionLabel', () => {
  it('names the category and the percentage', () => {
    expect(
      promotionLabel({ ...base, menu_category_id: 'c1', category_name: 'Breakfast', percent_bp: 1000 }),
    ).toBe('Breakfast 10%');
  });

  it('keeps a fractional percentage but drops trailing zeros', () => {
    expect(
      promotionLabel({ ...base, menu_category_id: 'c1', category_name: 'Desserts', percent_bp: 1550 }),
    ).toBe('Desserts 15.5%');
  });

  it('falls back to a generic word rather than rendering "undefined"', () => {
    expect(promotionLabel({ ...base, menu_category_id: 'c1', percent_bp: 1000 })).toBe('Category 10%');
  });

  it('omits the percentage when the row predates percent_bp', () => {
    expect(
      promotionLabel({ ...base, menu_category_id: 'c1', category_name: 'Breakfast' }),
    ).toBe('Breakfast');
  });

  it('returns null for a non-promotion so callers fall back to the reason', () => {
    expect(promotionLabel(base)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import { validateLadder, worstCase, type Draft } from './ladder';

function tier(over: Partial<Draft> = {}): Draft {
  return {
    min_score: 10,
    label: '10% off',
    reward_kind: 'percent',
    percent_bp: 1000,
    amount_cents: null,
    menu_item_id: null,
    max_discount_cents: 20000,
    ...over,
  };
}

describe('reward ladder validation', () => {
  it('accepts a sensible ladder', () => {
    expect(
      validateLadder([
        tier({ min_score: 0, label: 'So close', reward_kind: 'none', percent_bp: null, max_discount_cents: null }),
        tier({ min_score: 10 }),
        tier({ min_score: 40, label: 'Free tea', reward_kind: 'flat', percent_bp: null, max_discount_cents: null, amount_cents: 15000 }),
      ]),
    ).toBe('');
  });

  it('accepts an empty ladder — a campaign in progress is not an error', () => {
    expect(validateLadder([])).toBe('');
  });

  it('rejects duplicate thresholds, naming the score', () => {
    const msg = validateLadder([tier({ min_score: 10 }), tier({ min_score: 10, label: 'Other' })]);
    expect(msg).toContain('10');
    expect(msg).toContain('distinct');
  });

  it('rejects a blank label — it is what the guest reads on the ladder', () => {
    expect(validateLadder([tier({ label: '   ' })])).toContain('label');
  });

  it('rejects a negative threshold', () => {
    expect(validateLadder([tier({ min_score: -1 })])).toContain("can't be negative");
  });

  // The important one: without a ceiling the cost of a percentage reward is
  // unknown until it lands on a bill, so the budget cap cannot be enforced.
  it('rejects a percent reward with no maximum', () => {
    expect(validateLadder([tier({ max_discount_cents: null })])).toContain('maximum');
  });

  it('rejects an out-of-range percent', () => {
    expect(validateLadder([tier({ percent_bp: 0 })])).toContain('between 1%');
    expect(validateLadder([tier({ percent_bp: 10001 })])).toContain('between 1%');
  });

  it('rejects a flat reward with no amount', () => {
    expect(
      validateLadder([tier({ reward_kind: 'flat', percent_bp: null, max_discount_cents: null, amount_cents: null })]),
    ).toContain('amount');
  });

  it('rejects a free-item reward with no item', () => {
    expect(
      validateLadder([tier({ reward_kind: 'free_item', percent_bp: null, max_discount_cents: null })]),
    ).toContain('menu item');
  });

  it('a consolation tier needs no value', () => {
    expect(
      validateLadder([tier({ reward_kind: 'none', percent_bp: null, max_discount_cents: null })]),
    ).toBe('');
  });
});

describe('worst case', () => {
  // Must agree with the server's budget basis: a percent tier costs its
  // ceiling, which is the only figure knowable up front.
  it('values a percent tier at its ceiling', () => {
    expect(worstCase([tier({ max_discount_cents: 30000 })])).toBe(30000);
  });

  it('values a flat tier at its amount, and takes the dearest tier', () => {
    expect(
      worstCase([
        tier({ min_score: 10, max_discount_cents: 5000 }),
        tier({ min_score: 20, reward_kind: 'flat', percent_bp: null, max_discount_cents: null, amount_cents: 25000 }),
      ]),
    ).toBe(25000);
  });

  it('a consolation-only ladder costs nothing', () => {
    expect(worstCase([tier({ reward_kind: 'none', percent_bp: null, max_discount_cents: null })])).toBe(0);
  });

  it('an empty ladder costs nothing', () => {
    expect(worstCase([])).toBe(0);
  });
});

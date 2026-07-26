import { describe, it, expect } from 'vitest';

import { formatNPR, formatRupees, parsePriceInput } from '@/components/Money';
import { findVarianceMatch } from './variance-match';

// The web app has no component tests, so the money math that lives in the
// browser gets pinned here: formatting (what the operator reads), input parsing
// (what they type) and the variance-match suggestion (what the app tells them to
// do about a drawer that doesn't balance).

describe('formatNPR', () => {
  it('renders paisa as rupees', () => {
    expect(formatNPR(0)).toBe('रू 0');
    expect(formatNPR(100)).toBe('रू 1');
    expect(formatNPR(23400)).toBe('रू 234');
  });

  it('keeps paisa when they are not round', () => {
    expect(formatNPR(20708)).toBe('रू 207.08');
    expect(formatNPR(1)).toBe('रू 0.01');
  });

  it('groups thousands in the Indian convention', () => {
    // 1,23,456.78 — lakh grouping, not 123,456.78.
    expect(formatNPR(12345678)).toBe('रू 1,23,456.78');
  });

  it('renders negatives (an overdrawn account) rather than hiding the sign', () => {
    expect(formatNPR(-5000)).toBe('रू -50');
  });

  // formatRupees takes rupees, not paisa — payroll stores numeric rupees. Mixing
  // the two would be a 100× error, so the distinction is pinned.
  it('formatRupees treats its input as rupees', () => {
    expect(formatRupees(234)).toBe('रू 234');
    expect(formatNPR(234)).toBe('रू 2.34');
  });
});

describe('parsePriceInput', () => {
  it('parses rupee input into paisa', () => {
    expect(parsePriceInput('234')).toBe(23400);
    expect(parsePriceInput('207.08')).toBe(20708);
    expect(parsePriceInput('0.5')).toBe(50);
  });

  it('rounds to the nearest paisa rather than truncating', () => {
    expect(parsePriceInput('12.005')).toBe(1201);
    expect(parsePriceInput('12.004')).toBe(1200);
  });

  it('ignores currency decoration the user may paste in', () => {
    expect(parsePriceInput('रू 1,234.50')).toBe(123450);
    expect(parsePriceInput('Rs 99')).toBe(9900);
  });

  it('returns null for input with no number in it', () => {
    expect(parsePriceInput('')).toBeNull();
    expect(parsePriceInput('abc')).toBeNull();
  });

  // Documented behaviour, not an endorsement: the minus sign is stripped, so a
  // pasted negative becomes positive. Amount fields are all "how much", and the
  // API rejects <= 0, but this is where it happens — pinned so a future change
  // is deliberate. (The mobile parser does the same; see money.test.ts there.)
  it('strips a leading minus instead of returning a negative', () => {
    expect(parsePriceInput('-50')).toBe(5000);
  });
});

describe('findVarianceMatch', () => {
  const pay = (id: string, method: string, amount: number) =>
    ({ id, order_id: 'o', method, amount_cents: amount, reference_no: '', recorded_at: '' }) as never;

  it('says nothing when the drawer balances', () => {
    expect(findVarianceMatch([pay('a', 'cash', 5000)], 0)).toBeNull();
    expect(findVarianceMatch([pay('a', 'cash', 5000)], null)).toBeNull();
  });

  // SHORT: expected cash counts a cash payment that never physically arrived, so
  // the suspect is a CASH payment of exactly the shortfall, and the fix is to
  // reclassify it as online.
  it('suggests flipping a cash payment to online when short by its exact amount', () => {
    const m = findVarianceMatch([pay('a', 'cash', 5000), pay('b', 'cash', 1200)], -5000);
    expect(m?.payment.id).toBe('a');
    expect(m?.to).toBe('online');
  });

  // OVER: the till holds cash that expected doesn't account for, so the suspect
  // is an ONLINE payment that was actually taken in cash.
  it('suggests flipping an online payment to cash when over by its exact amount', () => {
    const m = findVarianceMatch([pay('a', 'other', 3000), pay('b', 'cash', 3000)], 3000);
    expect(m?.payment.id).toBe('a');
    expect(m?.to).toBe('cash');
  });

  it('stays silent when two payments would fit — a suggestion must not be a guess', () => {
    expect(findVarianceMatch([pay('a', 'cash', 5000), pay('b', 'cash', 5000)], -5000)).toBeNull();
  });

  it('stays silent when no payment matches the variance', () => {
    expect(findVarianceMatch([pay('a', 'cash', 5000)], -4999)).toBeNull();
  });

  it('never suggests a credit charge — it never touched the drawer', () => {
    expect(findVarianceMatch([pay('a', 'house_tab', 5000)], 5000)).toBeNull();
    expect(findVarianceMatch([pay('a', 'house_tab', 5000)], -5000)).toBeNull();
  });

  it('does not offer a cash payment as the culprit for an overage', () => {
    // Over means the drawer has MORE than expected; flipping a cash payment to
    // online would push expected further down and make it worse.
    expect(findVarianceMatch([pay('a', 'cash', 2500)], 2500)).toBeNull();
  });
});

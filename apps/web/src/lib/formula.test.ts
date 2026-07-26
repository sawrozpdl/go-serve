import { describe, it, expect } from 'vitest';

import { buildFormula, withoutZeroTerms } from './formula';

// The formula popover claims to explain a number. If its terms don't actually
// add up to that number, the explanation is wrong — which is worse than no
// explanation. These tests pin the arithmetic and the mismatch detection.

describe('buildFormula', () => {
  it('sums terms and confirms they match the stated result', () => {
    const f = buildFormula('Net revenue', 20708, [
      { label: 'Billed sales', cents: 23400 },
      { label: 'VAT collected', cents: 2692, op: '−' },
    ]);
    expect(f.computedCents).toBe(20708);
    expect(f.mismatch).toBe(false);
    expect(f.rows.map((r) => r.op)).toEqual(['', '−']);
  });

  it('treats the first term as the starting value regardless of its op', () => {
    const f = buildFormula('Total', 500, [
      { label: 'Start', cents: 500, op: '−' },
    ]);
    expect(f.computedCents).toBe(500);
    expect(f.rows[0]?.op).toBe('');
  });

  it('defaults an omitted op to +', () => {
    const f = buildFormula('Money in', 300, [
      { label: 'Sales', cents: 100 },
      { label: 'Credit collected', cents: 200 },
    ]);
    expect(f.computedCents).toBe(300);
    expect(f.rows[1]?.op).toBe('+');
  });

  it('flags a formula whose terms do not add up', () => {
    const f = buildFormula('Net revenue', 99999, [
      { label: 'Billed sales', cents: 23400 },
      { label: 'VAT collected', cents: 2692, op: '−' },
    ]);
    expect(f.mismatch).toBe(true);
    expect(f.computedCents).toBe(20708);
  });

  it('handles negatives without losing the sign', () => {
    const f = buildFormula('Net', -5000, [
      { label: 'Net revenue', cents: 10000 },
      { label: 'Expenses', cents: 15000, op: '−' },
    ]);
    expect(f.computedCents).toBe(-5000);
    expect(f.mismatch).toBe(false);
  });

  it('is exact in paisa — no floating-point drift across many terms', () => {
    const terms = Array.from({ length: 50 }, (_, i) => ({
      label: `t${i}`,
      cents: 1,
      op: '+' as const,
    }));
    const f = buildFormula('Fifty paisa', 50, terms);
    expect(f.computedCents).toBe(50);
    expect(f.mismatch).toBe(false);
  });
});

describe('withoutZeroTerms', () => {
  it('drops zero terms so a simple day reads simply', () => {
    const kept = withoutZeroTerms([
      { label: 'Cash', cents: 5000 },
      { label: 'Credit collected', cents: 0 },
      { label: 'Drops', cents: 0 },
    ]);
    expect(kept.map((t) => t.label)).toEqual(['Cash']);
  });

  it('keeps the first term even when it is zero — a zero figure still explains itself', () => {
    const kept = withoutZeroTerms([
      { label: 'Billed sales', cents: 0 },
      { label: 'VAT', cents: 0, op: '−' },
    ]);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.label).toBe('Billed sales');
  });

  it('never returns an empty formula', () => {
    expect(withoutZeroTerms([])).toEqual([]);
    expect(withoutZeroTerms([{ label: 'Only', cents: 0 }])).toHaveLength(1);
  });

  // The arithmetic must survive the pruning: dropping a zero can't change a sum.
  it('preserves the sum it explains', () => {
    const terms = [
      { label: 'Sales', cents: 23400 },
      { label: 'Nothing', cents: 0, op: '−' as const },
      { label: 'VAT', cents: 2692, op: '−' as const },
    ];
    const full = buildFormula('Net', 20708, terms);
    const pruned = buildFormula('Net', 20708, withoutZeroTerms(terms));
    expect(pruned.computedCents).toBe(full.computedCents);
    expect(pruned.mismatch).toBe(false);
  });
});

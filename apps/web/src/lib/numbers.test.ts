import { describe, expect, it } from 'vitest';

import { normalizeQtyTyping, parseQtyInput } from './numbers';

describe('parseQtyInput', () => {
  it('accepts plain decimals with an optional sign', () => {
    expect(parseQtyInput('5')).toBe('5');
    expect(parseQtyInput('-3')).toBe('-3');
    expect(parseQtyInput('+200')).toBe('+200');
    expect(parseQtyInput('0.5')).toBe('0.5');
    expect(parseQtyInput('.5')).toBe('.5');
    expect(parseQtyInput('  2  ')).toBe('2');
  });

  it('folds keyboard minus look-alikes', () => {
    // '_' shares the '-' key on phone keyboards — the prod 500 was "_1".
    expect(parseQtyInput('_1')).toBe('-1');
    expect(parseQtyInput('−2')).toBe('-2');
    expect(parseQtyInput('–2')).toBe('-2');
  });

  it('rejects anything Postgres numeric would refuse', () => {
    expect(parseQtyInput('')).toBeNull();
    expect(parseQtyInput('-')).toBeNull();
    expect(parseQtyInput('abc')).toBeNull();
    expect(parseQtyInput('1.2.3')).toBeNull();
    expect(parseQtyInput('5 units')).toBeNull();
    expect(parseQtyInput('1e5')).toBeNull();
    expect(parseQtyInput('1,5')).toBeNull();
  });
});

describe('normalizeQtyTyping', () => {
  it('keeps intermediate typing states usable', () => {
    expect(normalizeQtyTyping('')).toBe('');
    expect(normalizeQtyTyping('-')).toBe('-');
    expect(normalizeQtyTyping('1.')).toBe('1.');
  });

  it('drops characters a number cannot contain', () => {
    expect(normalizeQtyTyping('_1')).toBe('-1');
    expect(normalizeQtyTyping('5 units')).toBe('5');
    expect(normalizeQtyTyping('12abc.5')).toBe('12.5');
  });
});

import { describe, expect, it } from 'vitest';
import { amountInWords, discountPercent, normalizePAN, rupeesInWords } from '@cafe-mgmt/api-types';
import { buyerValid, cleanBuyer } from './fiscal';

describe('rupeesInWords (Nepali scale)', () => {
  it.each([
    [0, 'Zero'],
    [7, 'Seven'],
    [19, 'Nineteen'],
    [40, 'Forty'],
    [115, 'One Hundred Fifteen'],
    [1130, 'One Thousand One Hundred Thirty'],
    [100000, 'One Lakh'],
    [2345678, 'Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight'],
    [150000000, 'Fifteen Crore'],
    [123456789, 'Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine'],
  ])('%i → %s', (n, words) => {
    expect(rupeesInWords(n)).toBe(words);
  });

  it('adds paisa and the closing word', () => {
    expect(amountInWords(113050)).toBe('Rupees One Thousand One Hundred Thirty and Fifty Paisa Only');
    expect(amountInWords(100)).toBe('Rupees One Only');
  });
});

describe('discountPercent', () => {
  it('is the share of the pre-discount amount', () => {
    expect(discountPercent(100000, 10000)).toBe('10.00');
    expect(discountPercent(0, 0)).toBe('0.00');
  });
});

describe('buyer helpers', () => {
  it('normalises and validates PAN', () => {
    expect(normalizePAN('601-234 567')).toBe('601234567');
    expect(normalizePAN('12')).toBeNull();
    expect(buyerValid({ pan: '12' })).toBe(false);
    expect(buyerValid({})).toBe(true);
  });
  it('sends nothing for a walk-in', () => {
    expect(cleanBuyer({ name: ' ', pan: '' })).toBeUndefined();
    expect(cleanBuyer({ name: ' Acme ', pan: '601-234-567' })).toEqual({ name: 'Acme', pan: '601234567' });
  });
});

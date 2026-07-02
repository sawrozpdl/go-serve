import { parsePriceToCents, centsToPriceInput } from '../money';

describe('parsePriceToCents', () => {
  it('parses plain and decimal amounts', () => {
    expect(parsePriceToCents('12')).toBe(1200);
    expect(parsePriceToCents('12.5')).toBe(1250);
    expect(parsePriceToCents('12.99')).toBe(1299);
    expect(parsePriceToCents('0')).toBe(0);
  });
  it('strips currency symbols, commas, and spaces', () => {
    expect(parsePriceToCents('Rs 1,200.50')).toBe(120050);
    expect(parsePriceToCents('  99 ')).toBe(9900);
  });
  it('rounds to the nearest cent', () => {
    expect(parsePriceToCents('12.005')).toBe(1201);
  });
  it('returns 0 for empty / non-numeric / negative', () => {
    expect(parsePriceToCents('')).toBe(0);
    expect(parsePriceToCents('abc')).toBe(0);
    expect(parsePriceToCents('-5')).toBe(500); // '-' stripped → "5"
  });
});

describe('centsToPriceInput', () => {
  it('renders a compact editable string', () => {
    expect(centsToPriceInput(1200)).toBe('12');
    expect(centsToPriceInput(1250)).toBe('12.5');
    expect(centsToPriceInput(1299)).toBe('12.99');
  });
  it('is empty for null / undefined / zero', () => {
    expect(centsToPriceInput(null)).toBe('');
    expect(centsToPriceInput(undefined)).toBe('');
    expect(centsToPriceInput(0)).toBe('');
  });
});

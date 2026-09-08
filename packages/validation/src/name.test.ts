import { describe, expect, it } from 'vitest';
import { isValidName, normalizeName, NAME_MAX } from './name';

// The same table as apps/api/internal/api/name_test.go — keep them in step.
const CASES: Array<{ in: string; want: string | null; why: string }> = [
  { in: 'Cafe Mocha', want: 'Cafe Mocha', why: 'ordinary name passes through untouched' },
  {
    in: 'Cafe+Mocha----@DFG56789...',
    want: 'Cafe+Mocha----@DFG56789...',
    why: "punctuation and symbols are a café's business, not ours",
  },
  { in: '  Cafe Mocha  ', want: 'Cafe Mocha', why: 'trimmed' },
  { in: 'Cafe   Mocha', want: 'Cafe Mocha', why: 'internal whitespace runs collapse' },
  { in: 'Cafe\tMocha', want: 'Cafe Mocha', why: 'tab becomes a separator, not a join' },
  { in: 'Cafe\nMocha', want: 'Cafe Mocha', why: 'a newline would be a line feed on the ESC/POS docket' },
  { in: 'Cafe Mocha', want: 'Cafe Mocha', why: 'NBSP is a space' },
  { in: 'Cafe​Mocha', want: 'CafeMocha', why: 'zero-width space is dropped, not turned into a gap' },
  { in: 'Cafe‮Mocha', want: 'CafeMocha', why: 'bidi override dropped — it can reorder the whole line' },
  { in: 'चिया', want: 'चिया', why: 'Devanagari is a first-class name' },
  { in: '', want: null, why: 'empty rejected' },
  { in: '   ', want: null, why: 'whitespace-only rejected — this used to save as a blank name' },
  { in: '​​', want: null, why: 'invisible-only rejected' },
  { in: '50% off', want: '50% off', why: 'a percent sign in a name is fine; escapeLike keeps search honest' },
];

describe('normalizeName', () => {
  it.each(CASES)('$why', ({ in: input, want }) => {
    if (want === null) {
      expect(isValidName(input)).toBe(false);
      return;
    }
    expect(normalizeName(input)).toBe(want);
    expect(isValidName(input)).toBe(true);
  });

  it('is idempotent', () => {
    for (const { in: input } of CASES) {
      const once = normalizeName(input);
      expect(normalizeName(once)).toBe(once);
    }
  });

  it('composes NFC so a decomposed accent is not a second row', () => {
    expect(normalizeName('Café Mocha')).toBe('Café Mocha');
  });
});

describe('isValidName length', () => {
  const long = 'अ'.repeat(NAME_MAX);

  it('counts code points, not bytes — Devanagari gets the full allowance', () => {
    expect(isValidName(long)).toBe(true);
  });

  it('rejects one past the cap', () => {
    expect(isValidName(`${long}अ`)).toBe(false);
  });

  it('trims before capping, so trailing spaces cannot push a name over', () => {
    expect(isValidName(`${long}     `)).toBe(true);
  });
});

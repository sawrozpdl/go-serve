/**
 * How an add-on group describes itself. The two select numbers are a rule,
 * and the rule is what changes the cashier's job.
 */
import { groupRule, groupReuse } from '../addOns';

describe('groupRule', () => {
  it('separates a blocking group from an optional one', () => {
    // min_select >= 1 means the POS refuses the line until someone answers.
    expect(groupRule({ min_select: 1, max_select: 1 })).toBe('Must pick exactly one');
    expect(groupRule({ min_select: 0, max_select: 1 })).toBe('Optional — pick at most one');
  });

  it('treats null, undefined and 0 max as unlimited', () => {
    expect(groupRule({ min_select: 0, max_select: null })).toBe('Optional — pick any number');
    expect(groupRule({ min_select: 0, max_select: undefined })).toBe('Optional — pick any number');
    expect(groupRule({ min_select: 0, max_select: 0 })).toBe('Optional — pick any number');
  });

  it('describes a required unlimited group', () => {
    expect(groupRule({ min_select: 1, max_select: null })).toBe(
      'Must pick at least one — any number allowed',
    );
  });

  it('spells out a genuine range', () => {
    expect(groupRule({ min_select: 2, max_select: 3 })).toBe('Must pick between 2 and 3');
  });

  it('spells out an optional cap above one', () => {
    expect(groupRule({ min_select: 0, max_select: 3 })).toBe('Optional — pick up to 3');
  });
});

describe('groupReuse', () => {
  it('names the blast radius before an edit, not after', () => {
    expect(groupReuse({ item_count: 4, category_count: 1 })).toBe('Used on 4 items and 1 category');
  });

  it('gets the singulars and plurals right', () => {
    expect(groupReuse({ item_count: 1, category_count: 0 })).toBe('Used on 1 item');
    expect(groupReuse({ item_count: 0, category_count: 2 })).toBe('Used on 2 categories');
  });

  it('says plainly when nothing uses it', () => {
    expect(groupReuse({ item_count: 0, category_count: 0 })).toBe('Not attached to anything yet');
  });
});

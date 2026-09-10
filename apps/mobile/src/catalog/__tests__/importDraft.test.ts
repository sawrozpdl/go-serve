/**
 * The import draft → payload conversion. The draft is what a language model
 * read off a photograph and a human then corrected, so everything here is
 * about surviving input that is nearly right.
 */
import type { ImportCategoryDraft } from '@cafe-mgmt/menu-import';
import { draftPriceToCents, draftProblems, draftItemCount, toImportPayload } from '../importDraft';

const cat = (name: string, items: { name: string; price: string }[]): ImportCategoryDraft => ({
  name,
  icon: '',
  items: items.map((i) => ({ ...i, description: '', icon: '' })),
});

describe('draftPriceToCents', () => {
  it('reads plain and decimal major units', () => {
    expect(draftPriceToCents('120')).toBe(12000);
    expect(draftPriceToCents('125.5')).toBe(12550);
  });

  it('survives grouping commas and a stray currency symbol', () => {
    // Models return "Rs 1,250" more often than they return 1250.
    expect(draftPriceToCents('1,250')).toBe(125000);
    expect(draftPriceToCents('Rs 120')).toBe(12000);
  });

  it('rounds to the paisa rather than carrying a float', () => {
    expect(draftPriceToCents('12.345')).toBe(1235);
  });

  it('rejects what is not a usable price', () => {
    expect(draftPriceToCents('')).toBeNull();
    expect(draftPriceToCents('   ')).toBeNull();
    expect(draftPriceToCents('market price')).toBeNull();
    expect(draftPriceToCents('0')).toBeNull();
  });
});

describe('draftProblems', () => {
  it('names every row that cannot be imported, and why', () => {
    // Pasting forty items and getting thirty-eight is only acceptable if you
    // are told which two.
    const problems = draftProblems([
      cat('Coffee', [
        { name: 'Espresso', price: '120' },
        { name: 'Market fish', price: 'market price' },
        { name: 'Mystery', price: '' },
      ]),
    ]);
    expect(problems).toEqual([
      { category: 'Coffee', item: 'Market fish', reason: '"market price" is not a price' },
      { category: 'Coffee', item: 'Mystery', reason: 'no price' },
    ]);
  });

  it('is empty for a clean draft', () => {
    expect(draftProblems([cat('Coffee', [{ name: 'Espresso', price: '120' }])])).toEqual([]);
  });
});

describe('toImportPayload', () => {
  it('drops unpriced rows and counts what will actually be sent', () => {
    const cats = [
      cat('Coffee', [
        { name: 'Espresso', price: '120' },
        { name: 'Mystery', price: '' },
      ]),
    ];
    expect(draftItemCount(cats)).toBe(1);
    const payload = toImportPayload(cats, { dryRun: true, overwriteExisting: true });
    expect(payload.categories[0].items).toEqual([{ name: 'Espresso', price_cents: 12000 }]);
  });

  it('drops a category left empty, rather than creating it bare', () => {
    // An empty category reads as a successful import of nothing.
    const payload = toImportPayload([cat('Specials', [{ name: 'Mystery', price: '' }])], {
      dryRun: false,
      overwriteExisting: false,
    });
    expect(payload.categories).toEqual([]);
  });

  it('carries the dry-run and overwrite flags through', () => {
    const p = toImportPayload([cat('C', [{ name: 'X', price: '10' }])], {
      dryRun: true,
      overwriteExisting: false,
    });
    expect(p.dry_run).toBe(true);
    expect(p.overwrite_existing).toBe(false);
  });

  it('omits optional fields rather than sending empty strings', () => {
    const p = toImportPayload([cat('C', [{ name: 'X', price: '10' }])], {
      dryRun: false,
      overwriteExisting: true,
    });
    expect(p.categories[0].icon).toBeUndefined();
    expect(p.categories[0].items[0].description).toBeUndefined();
  });

  it('trims the names a model padded', () => {
    const p = toImportPayload([cat('  Coffee ', [{ name: ' Espresso ', price: '10' }])], {
      dryRun: false,
      overwriteExisting: true,
    });
    expect(p.categories[0].name).toBe('Coffee');
    expect(p.categories[0].items[0].name).toBe('Espresso');
  });
});

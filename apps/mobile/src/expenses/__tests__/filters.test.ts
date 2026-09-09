/**
 * The expense filter maths. Every case pins `today` so the suite is the same
 * on any day of the year — and so the month-boundary cases can be written at
 * all.
 */
import type { Expense } from '@cafe-mgmt/api-types';
import { todayStr } from '@/lib/dates';
import {
  initialFilters,
  rangeBounds,
  toQuery,
  activeFilterCount,
  filtersActive,
  rangeLabel,
  summarize,
  paidFromLabel,
  vendorSuggestions,
  paidAtIso,
  isValidHHMM,
} from '../filters';

const TODAY = '2026-09-09';
const base = initialFilters(TODAY);

describe('defaults to the real today', () => {
  // Every helper takes `today` so the suite can pin it; called without one they
  // must still agree with the clock, or the screen and the tests diverge.
  it('opens unfiltered on the current day', () => {
    const now = todayStr();
    const state = initialFilters();
    expect(state.day).toBe(now);
    expect(activeFilterCount(state)).toBe(0);
    expect(filtersActive(state)).toBe(false);
    expect(rangeLabel(state)).toBe('Today');
  });
});

describe('rangeBounds', () => {
  it('a single day is from and to the same date', () => {
    expect(rangeBounds(base)).toEqual({ from: TODAY, to: TODAY });
  });

  it('the week window is 7 days INCLUDING the anchor, not 8', () => {
    expect(rangeBounds({ ...base, range: 'week' })).toEqual({ from: '2026-09-03', to: TODAY });
  });

  it('the month window starts on the 1st of the anchor month', () => {
    expect(rangeBounds({ ...base, range: 'month' })).toEqual({ from: '2026-09-01', to: TODAY });
  });

  it('the week window crosses a month boundary correctly', () => {
    expect(rangeBounds({ ...base, range: 'week', day: '2026-09-02' })).toEqual({
      from: '2026-08-27',
      to: '2026-09-02',
    });
  });

  it('all time has no bounds at all', () => {
    expect(rangeBounds({ ...base, range: 'all' })).toEqual({});
  });
});

describe('toQuery', () => {
  it('sends plain dates — the server reads them as whole cafe-local days', () => {
    // The handler compares half-open in the tenant's timezone, so the day
    // boundary follows the cafe rather than the phone. A time suffix would be
    // discarded by its ::date cast anyway.
    expect(toQuery(base)).toEqual({
      from: TODAY,
      to: TODAY,
      q: undefined,
      expense_category_id: undefined,
      paid_from: undefined,
    });
  });

  it('omits blank filters rather than sending empty params', () => {
    const q = toQuery({ ...base, range: 'all', q: '   ' });
    expect(q.from).toBeUndefined();
    expect(q.to).toBeUndefined();
    expect(q.q).toBeUndefined();
  });

  it('trims the search text', () => {
    expect(toQuery({ ...base, q: '  beans ' }).q).toBe('beans');
  });

  it('passes category and source through', () => {
    const q = toQuery({ ...base, categoryId: 'c1', paidFrom: 'owner_cash' });
    expect(q.expense_category_id).toBe('c1');
    expect(q.paid_from).toBe('owner_cash');
  });
});

describe('activeFilterCount', () => {
  it('the default — today, nothing else — counts as unfiltered', () => {
    expect(activeFilterCount(base, TODAY)).toBe(0);
    expect(filtersActive(base, TODAY)).toBe(false);
  });

  it('stepping off today counts, even with no other filter', () => {
    expect(activeFilterCount({ ...base, day: '2026-09-08' }, TODAY)).toBe(1);
  });

  it('counts each dimension once', () => {
    expect(
      activeFilterCount({ range: 'month', day: TODAY, q: 'gas', categoryId: 'c1', paidFrom: 'bank' }, TODAY),
    ).toBe(4);
  });

  it('whitespace is not a search', () => {
    expect(activeFilterCount({ ...base, q: '   ' }, TODAY)).toBe(0);
  });
});

describe('rangeLabel', () => {
  it('names today and yesterday', () => {
    expect(rangeLabel(base, TODAY)).toBe('Today');
    expect(rangeLabel({ ...base, day: '2026-09-08' }, TODAY)).toBe('Yesterday');
  });

  it('says "This month" only for the current one', () => {
    expect(rangeLabel({ ...base, range: 'month' }, TODAY)).toBe('This month');
    expect(rangeLabel({ ...base, range: 'month', day: '2026-07-14' }, TODAY)).toContain('July');
  });

  it('names the rolling week and all time', () => {
    expect(rangeLabel({ ...base, range: 'week' }, TODAY)).toBe('Last 7 days');
    expect(rangeLabel({ ...base, range: 'all' }, TODAY)).toBe('All time');
  });
});

describe('summarize', () => {
  const rows = [{ amount_cents: 4500 }, { amount_cents: 250 }] as Expense[];

  it('counts and totals what the filters matched', () => {
    expect(summarize(rows)).toEqual({ count: 2, totalCents: 4750 });
  });

  it('an unloaded list is zero, not a crash', () => {
    expect(summarize(undefined)).toEqual({ count: 0, totalCents: 0 });
  });
});

describe('paidFromLabel', () => {
  it('never leaks the raw enum', () => {
    expect(paidFromLabel('owner_cash', 'Sita')).toBe("Sita's cafe cash");
    expect(paidFromLabel('owner', 'Sita')).toBe('Sita paid');
    expect(paidFromLabel('drawer')).toBe('Cash drawer');
    expect(paidFromLabel('bank')).toBe('Bank');
  });

  it('falls back to "Owner" when the name did not come back', () => {
    expect(paidFromLabel('owner', null)).toBe('Owner paid');
    expect(paidFromLabel('owner_cash')).toBe("Owner's cafe cash");
  });

  it('shows an unknown source as-is rather than swallowing it', () => {
    expect(paidFromLabel('crypto')).toBe('crypto');
  });
});

describe('vendorSuggestions', () => {
  const all = ['Local Mill', 'NEA', 'Himalayan Beans', 'Milk Co'];

  it('matches anywhere in the name, not just the start', () => {
    expect(vendorSuggestions(all, 'mil')).toEqual(['Local Mill', 'Milk Co']);
  });

  it('drops the exact match — offering what is typed is noise', () => {
    expect(vendorSuggestions(all, 'NEA')).toEqual([]);
  });

  it('offers the most recent few when nothing is typed yet', () => {
    expect(vendorSuggestions(all, '', 2)).toEqual(['Local Mill', 'NEA']);
  });

  it('survives no vendor list', () => {
    expect(vendorSuggestions(undefined, 'x')).toEqual([]);
  });
});

describe('paidAtIso', () => {
  it('builds the instant from wall-clock time in the cafe', () => {
    // Local-time construction, so assert by reading the local fields back.
    const d = new Date(paidAtIso('2026-09-09', '14:30'));
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(9);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });

  it('falls back to midday, not midnight, when the time is unusable', () => {
    // Midnight plus a negative UTC offset would back-date the expense a day.
    expect(new Date(paidAtIso('2026-09-09', '')).getHours()).toBe(12);
  });
});

describe('isValidHHMM', () => {
  it.each([
    ['09:05', true],
    ['9:05', true],
    ['23:59', true],
    ['24:00', false],
    ['12:60', false],
    ['1230', false],
    ['', false],
  ])('%s → %s', (input, want) => {
    expect(isValidHHMM(input)).toBe(want);
  });
});

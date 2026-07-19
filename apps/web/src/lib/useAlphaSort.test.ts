import { describe, expect, it } from 'vitest';

import { sortByNameAlpha } from './useAlphaSort';

type Row = { id: number; name: string };

const rows: Row[] = [
  { id: 1, name: 'Charlie' },
  { id: 2, name: 'alpha' },
  { id: 3, name: 'Bravo' },
];

describe('sortByNameAlpha', () => {
  it('sorts case-insensitively by name', () => {
    expect(sortByNameAlpha(rows, (r) => r.name).map((r) => r.name)).toEqual([
      'alpha',
      'Bravo',
      'Charlie',
    ]);
  });

  it('does not mutate the input array (server order preserved)', () => {
    sortByNameAlpha(rows, (r) => r.name);
    expect(rows.map((r) => r.name)).toEqual(['Charlie', 'alpha', 'Bravo']);
  });

  it('orders numeric suffixes naturally (Table 2 before Table 10)', () => {
    const tables = [{ name: 'Table 10' }, { name: 'Table 2' }, { name: 'Table 1' }];
    expect(sortByNameAlpha(tables, (t) => t.name).map((t) => t.name)).toEqual([
      'Table 1',
      'Table 2',
      'Table 10',
    ]);
  });
});

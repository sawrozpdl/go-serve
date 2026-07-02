import { breakpointFor, gridColumns, splitViewFor } from '../layout';

describe('breakpointFor', () => {
  it('classifies phone / small-tablet / tablet widths', () => {
    expect(breakpointFor(320)).toBe('compact');
    expect(breakpointFor(599)).toBe('compact');
    expect(breakpointFor(600)).toBe('medium');
    expect(breakpointFor(899)).toBe('medium');
    expect(breakpointFor(900)).toBe('expanded');
    expect(breakpointFor(1280)).toBe('expanded');
  });
});

describe('gridColumns', () => {
  it('fits columns to the target tile width', () => {
    expect(gridColumns(375, 170)).toBe(2); // phone: 2-up tiles
    expect(gridColumns(768, 170)).toBe(4); // small tablet
    expect(gridColumns(1024, 170)).toBe(6); // capped at default max
  });

  it('clamps to [min, max]', () => {
    expect(gridColumns(375, 400, 2, 6)).toBe(2); // too narrow → min
    expect(gridColumns(2000, 100, 1, 4)).toBe(4); // huge → max
  });

  it('returns min for degenerate inputs', () => {
    expect(gridColumns(0, 170)).toBe(1);
    expect(gridColumns(375, 0, 2)).toBe(2);
  });
});

describe('splitViewFor', () => {
  it('always splits on expanded, splits medium only in landscape', () => {
    expect(splitViewFor('expanded', false)).toBe(true);
    expect(splitViewFor('expanded', true)).toBe(true);
    expect(splitViewFor('medium', true)).toBe(true);
    expect(splitViewFor('medium', false)).toBe(false);
    expect(splitViewFor('compact', true)).toBe(false);
    expect(splitViewFor('compact', false)).toBe(false);
  });
});

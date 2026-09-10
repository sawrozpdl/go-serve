/**
 * Table status vocabulary. These four words decide whether a table can be
 * seated, so they have to say the same thing on the phone as on the floor.
 */
import {
  TABLE_STATUSES,
  tableStatusLabel,
  tableStatusTone,
  tableStatusEffect,
} from '../tableStatus';

describe('tableStatusLabel', () => {
  it('says what "dirty" actually means to a waiter', () => {
    // The raw enum reads as an insult about the furniture.
    expect(tableStatusLabel('dirty')).toBe('Needs clearing');
    expect(tableStatusLabel('free')).toBe('Free');
    expect(tableStatusLabel('occupied')).toBe('Occupied');
    expect(tableStatusLabel('reserved')).toBe('Reserved');
  });

  it('shows an unknown status as-is rather than blanking the pill', () => {
    expect(tableStatusLabel('teleported')).toBe('teleported');
  });

  it('covers every status the type allows', () => {
    for (const s of TABLE_STATUSES) expect(tableStatusLabel(s)).not.toBe(s);
  });
});

describe('tableStatusTone', () => {
  it('keeps the normal state quiet', () => {
    // Four loud pills is the same as none: `free` must not compete with the
    // three that need someone to act.
    expect(tableStatusTone('free')).toBe('success');
    expect(tableStatusTone('occupied')).toBe('warn');
    expect(tableStatusTone('dirty')).toBe('danger');
    expect(tableStatusTone('reserved')).toBe('neutral');
  });
});

describe('tableStatusEffect', () => {
  it('warns that freeing an occupied table does not close its tab', () => {
    // The tile and the tab are separate records; assuming otherwise is how a
    // serve gets forgotten.
    expect(tableStatusEffect('occupied', 'free')).toMatch(/open tab stays open/);
    expect(tableStatusEffect('occupied', 'dirty')).toMatch(/open tab stays open/);
  });

  it('explains each destination state', () => {
    expect(tableStatusEffect('free', 'reserved')).toMatch(/no new tab/);
    expect(tableStatusEffect('free', 'dirty')).toMatch(/cleared/);
    expect(tableStatusEffect('free', 'occupied')).toMatch(/without opening a tab/);
    expect(tableStatusEffect('dirty', 'free')).toMatch(/available again/);
  });

  it('says nothing when nothing changes', () => {
    expect(tableStatusEffect('free', 'free')).toBeNull();
  });
});

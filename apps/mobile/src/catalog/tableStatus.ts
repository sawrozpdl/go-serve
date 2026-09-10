/**
 * A service table's live status, in words and in a stamp tone.
 *
 * The four states are not decoration — each one blocks or allows something on
 * the floor, and a table stuck in the wrong one is unusable until someone
 * changes it. Until now only the Floor tab could clear a `dirty` table, and
 * nothing at all could clear a `reserved` one from a phone.
 */
import type { ServiceTable } from '@cafe-mgmt/api-types';

export type TableStatus = ServiceTable['status'];

export const TABLE_STATUSES: TableStatus[] = ['free', 'occupied', 'reserved', 'dirty'];

const LABELS: Record<TableStatus, string> = {
  free: 'Free',
  occupied: 'Occupied',
  reserved: 'Reserved',
  dirty: 'Needs clearing',
};

export function tableStatusLabel(status: string): string {
  return LABELS[status as TableStatus] ?? status;
}

/** Stamp tone. `free` is deliberately quiet: the normal state should not
 *  compete for attention with the three that need someone to do something. */
export function tableStatusTone(status: string): 'success' | 'warn' | 'danger' | 'neutral' {
  switch (status) {
    case 'occupied':
      return 'warn';
    case 'dirty':
      return 'danger';
    case 'reserved':
      return 'neutral';
    default:
      return 'success';
  }
}

/**
 * What changing a table's status by hand will actually do, so the operator is
 * not guessing. Setting a table free while a tab is open does NOT close the
 * tab — the two are separate records — which is the one outcome worth warning
 * about.
 */
export function tableStatusEffect(from: string, to: string): string | null {
  if (from === to) return null;
  if (from === 'occupied' && to !== 'occupied') {
    return 'This only changes the tile. An open tab stays open — settle it from the floor.';
  }
  switch (to) {
    case 'dirty':
      return 'The tile asks to be cleared before anyone is seated.';
    case 'reserved':
      return 'The table is held: no new tab can be started on it.';
    case 'occupied':
      return 'Marks the tile busy without opening a tab.';
    default:
      return 'The table becomes available again.';
  }
}

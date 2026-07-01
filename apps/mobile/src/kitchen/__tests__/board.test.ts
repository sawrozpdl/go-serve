import type { KitchenTicket } from '@cafe-mgmt/api-types';
import { partitionTickets, elapsedLabel, findNewInProgress, ticketUrgency } from '../board';

const t = (over: Partial<KitchenTicket>): KitchenTicket => ({
  item_id: 'i1',
  order_id: 'o1',
  menu_item_name: 'Latte',
  qty: 1,
  modifiers: null,
  notes: '',
  kitchen_status: 'in_progress',
  sent_to_kitchen_at: null,
  ready_at: null,
  ...over,
});

describe('partitionTickets', () => {
  it('splits ready from in-progress, preserving order', () => {
    const list = [
      t({ item_id: 'a', kitchen_status: 'in_progress' }),
      t({ item_id: 'b', kitchen_status: 'ready' }),
      t({ item_id: 'c', kitchen_status: 'in_progress' }),
    ];
    const { inProgress, ready } = partitionTickets(list);
    expect(inProgress.map((x) => x.item_id)).toEqual(['a', 'c']);
    expect(ready.map((x) => x.item_id)).toEqual(['b']);
  });

  it('handles an empty board', () => {
    expect(partitionTickets([])).toEqual({ inProgress: [], ready: [] });
  });
});

describe('elapsedLabel', () => {
  const now = new Date('2026-07-02T10:00:00Z').getTime();
  const ago = (sec: number) => new Date(now - sec * 1000).toISOString();

  it('formats seconds, minutes, and hours', () => {
    expect(elapsedLabel(now, ago(42))).toBe('42s');
    expect(elapsedLabel(now, ago(60))).toBe('1m');
    expect(elapsedLabel(now, ago(7 * 60))).toBe('7m');
    expect(elapsedLabel(now, ago(3 * 3600))).toBe('3h');
  });

  it('prefers readyAt over sentAt', () => {
    expect(elapsedLabel(now, ago(3600), ago(30))).toBe('30s');
  });

  it('clamps negatives to 0s and returns — for missing/invalid refs', () => {
    expect(elapsedLabel(now, ago(-10))).toBe('0s');
    expect(elapsedLabel(now, null)).toBe('—');
    expect(elapsedLabel(now, 'not-a-date')).toBe('—');
  });
});

describe('findNewInProgress', () => {
  const board = [
    t({ item_id: 'a', kitchen_status: 'in_progress' }),
    t({ item_id: 'b', kitchen_status: 'ready' }),
  ];

  it('seeds without alerting on first call (prev null)', () => {
    const { ids, hasNew } = findNewInProgress(null, board);
    expect(hasNew).toBe(false);
    expect([...ids]).toEqual(['a']); // only in-progress ids are tracked
  });

  it('flags a genuinely new in-progress ticket', () => {
    const prev = new Set(['a']);
    const next = [...board, t({ item_id: 'c', kitchen_status: 'in_progress' })];
    const { ids, hasNew } = findNewInProgress(prev, next);
    expect(hasNew).toBe(true);
    expect(ids.has('c')).toBe(true);
  });

  it('does not alert when nothing new arrived', () => {
    expect(findNewInProgress(new Set(['a']), board).hasNew).toBe(false);
  });

  it('does not alert when a ticket only leaves (marked ready/served)', () => {
    const { hasNew } = findNewInProgress(new Set(['a', 'x']), board);
    expect(hasNew).toBe(false);
  });
});

describe('ticketUrgency', () => {
  const now = new Date('2026-07-02T10:00:00Z').getTime();
  const minAgo = (m: number) => new Date(now - m * 60000).toISOString();

  it('tiers by minutes waited', () => {
    expect(ticketUrgency(now, minAgo(2))).toBe('fresh');
    expect(ticketUrgency(now, minAgo(6))).toBe('warn');
    expect(ticketUrgency(now, minAgo(15))).toBe('urgent');
  });

  it('is fresh for missing/invalid refs', () => {
    expect(ticketUrgency(now, null)).toBe('fresh');
    expect(ticketUrgency(now, 'nope')).toBe('fresh');
  });
});

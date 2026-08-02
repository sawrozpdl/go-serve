import { describe, it, expect } from 'vitest';

import { billingView, urgencyOf, expiryTime, GRACE_DAYS } from './superBilling';

const DAY = 86_400_000;
const NOW = new Date('2026-08-03T12:00:00Z').getTime();
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

/** Minimal row — only the four fields billingView reads. */
const row = (o: Partial<Parameters<typeof billingView>[0]> = {}) => ({
  status: 'active',
  billing_state: 'ok',
  ...o,
});

describe('billingView', () => {
  it('reports a live trial with the trial end as the governing date', () => {
    const v = billingView(row({ trial_ends_at: at(10) }), NOW);
    expect(v.phase).toBe('trial');
    expect(v.pill).toBe('ok');
    expect(v.writeLocked).toBe(false);
    expect(v.governingDate).toBe(at(10));
    expect(v.dateLabel).toBe('Trial ends');
  });

  it('nags but does not lock inside the grace window', () => {
    const v = billingView(row({ trial_ends_at: at(-(GRACE_DAYS - 1)) }), NOW);
    expect(v.phase).toBe('grace');
    expect(v.writeLocked).toBe(false);
  });

  it('locks once the trial is past grace', () => {
    const v = billingView(row({ trial_ends_at: at(-(GRACE_DAYS + 1)) }), NOW);
    expect(v.phase).toBe('expired');
    expect(v.writeLocked).toBe(true);
  });

  it('treats the grace boundary as still in grace', () => {
    // ComputeState uses `now < trialEndsAt + GraceDays`, so exactly on the
    // boundary is expired — one second inside it is not.
    const justInside = new Date(NOW - GRACE_DAYS * DAY + 1000).toISOString();
    expect(billingView(row({ trial_ends_at: justInside }), NOW).phase).toBe('grace');
  });

  it('flags a lapsed paid subscription past due WITHOUT locking writes', () => {
    // The backend deliberately never auto-locks the paid gate — only the trial
    // gate does that. Getting this wrong would show a paying customer as
    // locked when they can still take orders.
    const v = billingView(row({ paid_through_at: at(-30) }), NOW);
    expect(v.phase).toBe('past_due');
    expect(v.writeLocked).toBe(false);
    expect(v.pill).toBe('warn');
  });

  it('lets live paid coverage beat a stale trial date', () => {
    // Mirrors ComputeState's paidCurrent-first ordering, which exists so a
    // leftover trial_ends_at can never lock a paying customer out.
    const v = billingView(row({ trial_ends_at: at(-90), paid_through_at: at(200) }), NOW);
    expect(v.phase).toBe('paid');
    expect(v.writeLocked).toBe(false);
    expect(v.governingDate).toBe(at(200));
  });

  it('reports no clock for a comped tenant', () => {
    const v = billingView(row(), NOW);
    expect(v.phase).toBe('active');
    expect(v.governingDate).toBeNull();
    expect(v.writeLocked).toBe(false);
  });

  it('lets a manual lock win over everything', () => {
    const v = billingView(row({ billing_state: 'write_locked', paid_through_at: at(200) }), NOW);
    expect(v.phase).toBe('locked');
    expect(v.writeLocked).toBe(true);
  });

  it('lets suspension win over a manual lock', () => {
    const v = billingView(row({ status: 'suspended', billing_state: 'write_locked' }), NOW);
    expect(v.phase).toBe('suspended');
    expect(v.label).toBe('suspended');
  });
});

describe('urgencyOf', () => {
  it('ranks a locked workspace critical', () => {
    expect(urgencyOf(row({ billing_state: 'write_locked' }), NOW)).toBe('critical');
  });

  it('ranks a lapsed date critical even when writes are open', () => {
    expect(urgencyOf(row({ paid_through_at: at(-1) }), NOW)).toBe('critical');
  });

  it('warns inside the 14-day window and is calm outside it', () => {
    expect(urgencyOf(row({ trial_ends_at: at(14) }), NOW)).toBe('warn');
    expect(urgencyOf(row({ trial_ends_at: at(15) }), NOW)).toBe('ok');
  });

  it('treats a comped tenant as ok, not as an unknown', () => {
    expect(urgencyOf(row(), NOW)).toBe('ok');
  });
});

describe('expiryTime', () => {
  it('sorts a clockless tenant last', () => {
    expect(expiryTime(row())).toBe(Number.POSITIVE_INFINITY);
  });

  it('uses the governing date, not whichever field happens to be set', () => {
    // Paid coverage is live, so the trial date must not drive the sort.
    const t = row({ trial_ends_at: at(-90), paid_through_at: at(200) });
    expect(expiryTime(t)).toBe(new Date(at(200)).getTime());
  });
});

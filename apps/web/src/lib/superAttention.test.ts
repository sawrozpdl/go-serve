import { describe, it, expect } from 'vitest';
import type { AdminTenant, TenantUsage } from '@cafe-mgmt/api-types';

import { buildAttentionQueue, reasonTone } from './superAttention';

const DAY = 86_400_000;
const NOW = new Date('2026-08-03T12:00:00Z').getTime();
const at = (days: number) => new Date(NOW + days * DAY).toISOString();

function cafe(o: Partial<AdminTenant> = {}): AdminTenant {
  return {
    tenant_id: o.tenant_id ?? 'id-' + Math.random().toString(36).slice(2),
    slug: 'slug', name: 'A Cafe', status: 'active', billing_state: 'ok',
    plan_key: 'standard', plan_name: 'Standard', member_limit: 5,
    active_members: 2, pending_invites: 0, created_at: at(-200),
    contact_phone: '', owner_name: '', acquisition_source: 'direct',
    relationship_manager_id: 'rm-1', relationship_manager_name: 'Someone',
    ...o,
  };
}

function usage(o: Partial<TenantUsage> = {}): TenantUsage {
  return {
    tenant_id: 't', status: 'healthy', reasons: [], signals: [],
    orders_7d: 50, orders_prev_28d: 200, gross_7d_cents: 0,
    operating_days_7d: 7, shift_closed_days_7d: 7, active_members_7d: 3,
    menu_item_count: 20,
    adoption: { inventory: false, expenses: false, credit: false, staff: 0, outlets: 1 },
    ...o,
  };
}

describe('buildAttentionQueue', () => {
  it('leaves a healthy, managed café out entirely', () => {
    const t = cafe({ paid_through_at: at(90) });
    const q = buildAttentionQueue([t], new Map([[t.tenant_id, usage()]]), NOW);
    expect(q).toHaveLength(0);
  });

  it('ranks a locked café above a merely dormant one', () => {
    const locked = cafe({ tenant_id: 'locked', billing_state: 'write_locked' });
    const dormant = cafe({ tenant_id: 'dormant', paid_through_at: at(90) });
    const q = buildAttentionQueue(
      [dormant, locked],
      new Map([[dormant.tenant_id, usage({ status: 'dormant' })]]),
      NOW,
    );
    expect(q.map((i) => i.tenant.tenant_id)).toEqual(['locked', 'dormant']);
  });

  it('surfaces both a billing and a usage problem on the same café', () => {
    // The reason the two systems stay separate everywhere else, and why this
    // page merges them: a café can be failing on both at once.
    const t = cafe({ paid_through_at: at(-10) });
    const q = buildAttentionQueue(
      [t],
      new Map([[t.tenant_id, usage({ status: 'at_risk', signals: [
        { key: 'shift_discipline', grade: 'bad', detail: '4 of 5 trading days had no shift close', value: 4 },
      ] })]]),
      NOW,
    );
    expect(q[0]!.reasons).toContain('past_due');
    expect(q[0]!.reasons).toContain('at_risk');
    // The server's own sentence is reused rather than a vaguer restatement.
    expect(q[0]!.detail).toContain('4 of 5 trading days had no shift close');
  });

  it('sends each row to the tab that can fix it', () => {
    const billing = cafe({ tenant_id: 'b', billing_state: 'write_locked' });
    const usageBad = cafe({ tenant_id: 'u', paid_through_at: at(90) });
    const orphan = cafe({ tenant_id: 'o', paid_through_at: at(90), relationship_manager_id: undefined });

    const q = buildAttentionQueue(
      [billing, usageBad, orphan],
      new Map([
        [usageBad.tenant_id, usage({ status: 'dormant' })],
        [orphan.tenant_id, usage({ orders_7d: 30 })],
      ]),
      NOW,
    );
    const tabOf = (id: string) => q.find((i) => i.tenant.tenant_id === id)?.tab;
    expect(tabOf('b')).toBe('billing');
    expect(tabOf('u')).toBe('usage');
    expect(tabOf('o')).toBe('relationship');
  });

  it('does not nag about an unassigned café that is doing nothing anyway', () => {
    // Otherwise every abandoned test tenant floods the queue.
    const idle = cafe({ paid_through_at: at(90), relationship_manager_id: undefined });
    const q = buildAttentionQueue([idle], new Map([[idle.tenant_id, usage({ orders_7d: 0, status: 'healthy' })]]), NOW);
    expect(q).toHaveLength(0);
  });

  it('does flag an unassigned café that is actually trading', () => {
    const busy = cafe({ paid_through_at: at(90), relationship_manager_id: undefined });
    const q = buildAttentionQueue([busy], new Map([[busy.tenant_id, usage({ orders_7d: 40 })]]), NOW);
    expect(q[0]!.reasons).toEqual(['unassigned']);
  });

  it('still produces billing reasons before the usage rollup has loaded', () => {
    const t = cafe({ billing_state: 'write_locked' });
    const q = buildAttentionQueue([t], new Map(), NOW);
    expect(q[0]!.reasons).toEqual(['locked']);
  });

  it('breaks ties by how many things are wrong', () => {
    const one = cafe({ tenant_id: 'one', paid_through_at: at(-5) });
    const two = cafe({ tenant_id: 'two', paid_through_at: at(-5), relationship_manager_id: undefined });
    const q = buildAttentionQueue(
      [one, two],
      new Map([[two.tenant_id, usage({ orders_7d: 10 })], [one.tenant_id, usage()]]),
      NOW,
    );
    expect(q[0]!.tenant.tenant_id).toBe('two');
  });
});

describe('reasonTone', () => {
  it('reserves critical for the states that actually block a café', () => {
    expect(reasonTone('locked')).toBe('critical');
    expect(reasonTone('dormant')).toBe('critical');
    expect(reasonTone('past_due')).toBe('critical');
    expect(reasonTone('lapsed')).toBe('critical');
    // Everything below is a nudge, not an emergency.
    expect(reasonTone('at_risk')).toBe('warn');
    expect(reasonTone('expiring')).toBe('warn');
    expect(reasonTone('unassigned')).toBe('warn');
  });
});

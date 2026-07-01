import type { Me, Membership } from '@cafe-mgmt/api-types';
import { can, hasActiveMembership, activeMemberships, landingTab } from '../permissions';

function makeMe(perms: string[], memberships: Membership[] = []): Me {
  return {
    user_id: 'u1',
    email: 'a@b.c',
    name: 'A',
    active_permissions: perms,
    memberships,
  };
}

const mem = (slug: string, status: Membership['status']): Membership => ({
  tenant_id: `id-${slug}`,
  tenant_slug: slug,
  tenant_name: slug,
  roles: [],
  status,
});

describe('can', () => {
  it('is false with no user', () => {
    expect(can(null, 'order:read')).toBe(false);
    expect(can(undefined, 'order:read')).toBe(false);
  });

  it('matches an exact grant', () => {
    expect(can(makeMe(['order:read']), 'order:read')).toBe(true);
  });

  it('matches a resource wildcard', () => {
    expect(can(makeMe(['order:*']), 'order:settle')).toBe(true);
  });

  it('matches the global wildcard (owner)', () => {
    expect(can(makeMe(['*:*']), 'finance:owner_cash')).toBe(true);
  });

  it('denies an ungranted permission', () => {
    expect(can(makeMe(['kitchen:read']), 'order:create')).toBe(false);
  });

  it('treats missing active_permissions as empty', () => {
    const me = makeMe([]);
    delete (me as { active_permissions?: string[] }).active_permissions;
    expect(can(me, 'order:read')).toBe(false);
  });
});

describe('membership helpers', () => {
  const me = makeMe([], [mem('sahan', 'active'), mem('resell', 'pending'), mem('old', 'suspended')]);

  it('hasActiveMembership only counts active', () => {
    expect(hasActiveMembership(me, 'sahan')).toBe(true);
    expect(hasActiveMembership(me, 'resell')).toBe(false);
    expect(hasActiveMembership(me, 'nope')).toBe(false);
    expect(hasActiveMembership(null, 'sahan')).toBe(false);
  });

  it('activeMemberships filters to active only', () => {
    expect(activeMemberships(me).map((m) => m.tenant_slug)).toEqual(['sahan']);
    expect(activeMemberships(null)).toEqual([]);
  });
});

describe('landingTab', () => {
  it('sends order-takers to the floor', () => {
    expect(landingTab(makeMe(['order:create', 'order:read']))).toBe('floor');
    expect(landingTab(makeMe(['*:*']))).toBe('floor');
  });

  it('sends kitchen-only staff to the kitchen', () => {
    expect(landingTab(makeMe(['kitchen:read']))).toBe('kitchen');
    expect(landingTab(makeMe(['kitchen:update']))).toBe('kitchen');
  });

  it('sends a read-only viewer to history', () => {
    expect(landingTab(makeMe(['report:read']))).toBe('history');
    expect(landingTab(makeMe([]))).toBe('history');
    expect(landingTab(null)).toBe('history');
  });
});

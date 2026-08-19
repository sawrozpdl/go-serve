/**
 * The demo's grant set IS its scope switch, so it needs a test.
 *
 * The negative half matters more than the positive half. more/menu.tsx and
 * more/tables.tsx render their rows on a READ perm but gate the screen itself on
 * a WRITE perm and <Redirect href="/more" />, so granting menu:read without
 * menu:create would put a row on the More hub that throws the reviewer straight
 * back — a silently dead control, which is the exact policy violation that got the
 * app pulled. Same shape in more/outlets.tsx and more/inventory.tsx.
 *
 * If someone later wants those screens in the demo, the fix is to grant the WRITE
 * perms and implement the CRUD handlers — not to add the read token on its own.
 * This test is here to make that choice explicit rather than accidental.
 */
import { can } from '../../auth/permissions';
import { DEMO_PERMISSIONS, demoMe } from '../fixtures';

const me = demoMe();

describe('what a guest can reach', () => {
  it.each(DEMO_PERMISSIONS)('grants %s', (perm) => {
    expect(can(me, perm)).toBe(true);
  });

  it('covers the whole order → kitchen → settle path', () => {
    for (const perm of [
      'order:create',
      'order:add_items',
      'order:send_kitchen',
      'order:settle',
      'payment:record',
      'kitchen:update',
      'adjustment:apply',
      'report:read',
    ]) {
      expect(can(me, perm)).toBe(true);
    }
  });
});

describe('what a guest must NOT reach', () => {
  // Each of these would surface a More row whose screen bounces straight back.
  it.each([
    ['menu:read', 'more/menu.tsx gates on menu:create|menu:update'],
    ['table:read', 'more/tables.tsx gates on table:create|table:update'],
    ['outlet:read', 'more/outlets.tsx gates on outlet:create|outlet:update'],
    ['inventory:read', 'more/inventory.tsx gates on inventory write perms'],
  ])('withholds %s — %s', (perm) => {
    expect(can(me, perm)).toBe(false);
  });

  // These are simply out of scope: no demo handler backs them.
  it.each(['shift:read', 'expense:read', 'house_tab:read', 'member:read', 'tenant:update'])(
    'withholds %s (no demo handler)',
    (perm) => {
      expect(can(me, perm)).toBe(false);
    },
  );

  it('withholds tenant:update, which would surface Settings AND Printing', () => {
    // Printing's Scan/Test buttons open real LAN sockets that bypass the request
    // layer, so hiding the screen is the primary defence.
    expect(can(me, 'tenant:update')).toBe(false);
  });

  it('is not a platform admin, so the Super console stays hidden', () => {
    expect(me.is_platform_admin).toBe(false);
    expect(can(me, 'audit:read')).toBe(false);
  });

  it('holds no wildcard that would quietly grant everything', () => {
    expect(DEMO_PERMISSIONS).not.toContain('*:*');
    expect(DEMO_PERMISSIONS.filter((p) => p.endsWith(':*'))).toEqual([]);
  });
});

it('presents itself honestly as a guest on a sample workspace', () => {
  expect(me.name).toBe('Guest');
  expect(me.email).toMatch(/demo/);
  expect(me.memberships).toHaveLength(1);
  expect(me.memberships[0].status).toBe('active');
});

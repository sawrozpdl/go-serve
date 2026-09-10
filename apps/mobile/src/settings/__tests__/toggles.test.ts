/**
 * Preference defaults. An unset key is `undefined`, not `false`, and several
 * of these ship ON — reading a missing key as off would silently change how
 * the POS behaves for every cafe that has never opened Settings.
 */
import type { TenantPreferences } from '@cafe-mgmt/api-types';
import { TOGGLES, toggleValue, changedToggleCount } from '../toggles';

const spec = (key: string) => TOGGLES.find((t) => t.key === key)!;

describe('toggleValue', () => {
  it('honours a default-ON preference that has never been set', () => {
    expect(toggleValue({}, spec('stackItems'))).toBe(true);
    expect(toggleValue(undefined, spec('autoRecordPayment'))).toBe(true);
  });

  it('leaves a default-OFF preference off', () => {
    expect(toggleValue({}, spec('autoCleanTables'))).toBe(false);
  });

  it('an explicit false beats a default of true', () => {
    expect(toggleValue({ stackItems: false }, spec('stackItems'))).toBe(false);
  });

  it('an explicit true beats a default of false', () => {
    expect(toggleValue({ autoCleanTables: true }, spec('autoCleanTables'))).toBe(true);
  });
});

describe('changedToggleCount', () => {
  it('is zero for a workspace that has never touched Settings', () => {
    expect(changedToggleCount({})).toBe(0);
    expect(changedToggleCount(undefined)).toBe(0);
  });

  it('counts only what departs from the default', () => {
    const prefs: TenantPreferences = {
      stackItems: true, // already the default — not a change
      autoCleanTables: true, // default off
      dailyBriefEmail: false, // default on
    };
    expect(changedToggleCount(prefs)).toBe(2);
  });
});
